import fs from 'fs';
import fsp from 'fs/promises';

import { withPlayerSaveLock, writePlayerSave, checkSaveOperation, type SaveOperationState } from '#/server/login/PlayerSave.js';

import { compare, hashSync } from 'bcrypt-ts';
import { WebSocket, WebSocketServer } from 'ws';


import { db, toDbDate } from '#/db/query.js';
import Player from '#/engine/entity/Player.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import { PlayerStatEnabled } from '#/engine/entity/PlayerStat.js';
import Packet from '#/io/Packet.js';
import Environment from '#/util/Environment.js';
import { toSafeName } from '#/util/JString.js';
import { printInfo } from '#/util/Logger.js';
import { startManagementWeb } from '#/web.js';
import InvType from '#/cache/config/InvType.js';

async function updateHiscores(account: { id: number, staffmodlevel: number, banned_until: string | null } | undefined, player: Player, profile: string) {
    if (!account)
        return;

    if (account.staffmodlevel > 1) {
        return;
    }

    if (account.banned_until !== null && new Date(account.banned_until) >= new Date()) {
        return;
    }

    const insert = [];
    const update = [];

    let totalXp = 0;
    let totalLevel = 0;
    for (let i = 0; i < player.stats.length; i++) {
        if (!PlayerStatEnabled[i]) {
            continue;
        }

        totalXp += player.stats[i];
        totalLevel += player.baseLevels[i];
    }

    const existing = await db.selectFrom('hiscore_large').select('type').select('value').where('account_id', '=', account.id).where('type', '=', 0).where('profile', '=', profile).executeTakeFirst();
    if (existing && existing.value !== totalXp) {
        await db
            .updateTable('hiscore_large')
            .set({
                type: 0,
                level: totalLevel,
                value: totalXp,
                date: toDbDate(new Date())
            })
            .where('account_id', '=', account.id)
            .where('type', '=', 0)
            .where('profile', '=', profile)
            .execute();
    } else if (!existing) {
        await db
            .insertInto('hiscore_large')
            .values({
                account_id: account.id,
                profile,
                type: 0,
                level: totalLevel,
                value: totalXp
            })
            .execute();
    }

    for (let stat = 0; stat < player.stats.length; stat++) {
        if (!PlayerStatEnabled[stat]) {
            continue;
        }

        if (player.baseLevels[stat] >= 15) {
            const hiscoreType = stat + 1;

            // todo: can we upsert in kysely?
            const existing = await db.selectFrom('hiscore').select('type').select('value').where('account_id', '=', account.id).where('type', '=', hiscoreType).where('profile', '=', profile).executeTakeFirst();
            if (existing && existing.value !== player.stats[stat]) {
                update.push({
                    type: hiscoreType,
                    level: player.baseLevels[stat],
                    value: player.stats[stat],
                    date: toDbDate(new Date())
                });
            } else if (!existing) {
                insert.push({
                    account_id: account.id,
                    profile,
                    type: hiscoreType,
                    level: player.baseLevels[stat],
                    value: player.stats[stat]
                });
            }
        }
    }

    if (insert.length > 0) {
        await db.insertInto('hiscore').values(insert).execute();
    }

    // todo: batch update query?
    for (let i = 0; i < update.length; i++) {
        await db.updateTable('hiscore').set(update[i]).where('account_id', '=', account.id).where('type', '=', update[i].type).where('profile', '=', profile).execute();
    }
}

export default class LoginServer {
    private server: WebSocketServer;
    private loginRequests: Set<string> = new Set();
    private readonly worlds = new Map<string, { id: string; startedAt: number; ready: Promise<void> }>();
    private readonly worldCharacters = new Map<string, Set<string>>();
    private readonly saveSessions = new Map<string, { worldId: string; sessionId: string; nodeId: number }>();
    private readonly saveOperations = new Map<string, SaveOperationState>();

    rejectLoginForSafety(s: WebSocket, replyTo: number) {
        // Send opcode 7 ('Please try again') if something has gone wrong
        // during login attempt, which may be resolved by simply retrying.
        s.send(
            JSON.stringify({
                replyTo,
                response: 7
            })
        );
    }

    async wouldResetSaveFile(newSaveBytes: Buffer, profile: string, username: string) {
        // check whether `save`, if saved to disk, would have reset `username`'s progress.
        // it does this by checking whether the player's tick count has gone backwards.
        if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
            // No existing save - no problem.
            return false;
        }
        const existingSaveRaw = await fsp.readFile(`data/players/${profile}/${username}.sav`);
        const existingSave = PlayerLoading.load('tmp', new Packet(existingSaveRaw), null);
        const newSave = PlayerLoading.load('tmp', new Packet(newSaveBytes), null);
        if (existingSave.playtime > newSave.playtime) {
            // Int32, 1 per tick logged in. Should wrap only after insane amount of years.
            return true;
        }
        return false;
    }

    constructor() {
        if (Environment.LOGIN_SERVER && !Environment.EASY_STARTUP) {
            startManagementWeb();
        }

        InvType.load('data/pack');

        this.server = new WebSocketServer({ port: Environment.LOGIN_PORT, host: '0.0.0.0' }, () => {
            printInfo(`Login server listening on port ${Environment.LOGIN_PORT}`);
        });

        this.server.on('connection', (s: WebSocket) => {
            s.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString());
                    const { type, nodeId, nodeTime, profile } = msg;

                    const worldKey = `${profile}/${nodeId}`;
                    const { worldId } = msg;
                    if (type === 'world_startup') {
                        const previous = this.worlds.get(worldKey);
                        if (previous && previous.id === worldId) {
                            try { await previous.ready; return; } catch { /* retry a failed startup reset */ }
                        }
                        if (typeof worldId !== 'string' || !worldId || !Number.isSafeInteger(msg.worldStartedAt) ||
                            (previous && previous.id !== worldId && msg.worldStartedAt <= previous.startedAt)) {
                            throw new Error('Stale world incarnation');
                        }
                        // Fence the previous world's requests immediately, then wait for
                        // any accepted persistence/login to finish before resetting it.
                        const ready = (async () => {
                            for (const filename of this.worldCharacters.get(worldKey) ?? []) {
                                await withPlayerSaveLock(filename, async () => {
                                    if (this.saveSessions.get(filename)?.nodeId === nodeId) {
                                        this.saveSessions.delete(filename);
                                        this.saveOperations.delete(filename);
                                    }
                                });
                            }
                            await db.updateTable('account_login')
                                .set({ logged_in: 0, login_time: null })
                                .where('logged_in', '=', nodeId).where('profile', '=', profile).execute();
                        })();
                        this.worlds.set(worldKey, { id: worldId, startedAt: msg.worldStartedAt, ready });
                        await ready;
                        return;
                    }
                    const world = this.worlds.get(worldKey);
                    const filename = `data/players/${profile}/${msg.username}.sav`;
                    const assertCurrentWorld = () => {
                        if (!world || this.worlds.get(worldKey)?.id !== worldId) throw new Error('Stale world incarnation');
                    };
                    try {
                        if (['player_login', 'player_logout', 'player_autosave', 'player_force_logout'].includes(type)) {
                            assertCurrentWorld();
                            let characters = this.worldCharacters.get(worldKey);
                            if (!characters) { characters = new Set(); this.worldCharacters.set(worldKey, characters); }
                            characters.add(filename);
                            await world!.ready;
                        }
                    } catch {
                        if (msg.replyTo !== undefined) s.send(JSON.stringify({ replyTo: msg.replyTo, response: type === 'player_login' ? 7 : 1, saveId: msg.saveId }));
                        return;
                    }
                    if (type === 'player_login') {
                        const { nodeMembers, replyTo, username, password, uid, socket, remoteAddress, reconnecting, hasSave } = msg;
                        const safeName = toSafeName(username);
                        
                        if (this.loginRequests.has(safeName)) {
                            s.send(
                                JSON.stringify({
                                    replyTo,
                                    response: 8
                                })
                            );
                            return;
                        }
                        this.loginRequests.add(safeName);

                        try {
                            await withPlayerSaveLock(filename, async () => {
                                assertCurrentWorld();
                                const ipBan = await db.selectFrom('ipban').selectAll().where('ip', '=', remoteAddress).executeTakeFirst();

                                if (ipBan) {
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 7
                                        })
                                    );
                                    return;
                                }

                                let account = await db.selectFrom('account')
                                    .leftJoin('account_login', join => join
                                        .onRef('account_id', '=', 'id')
                                        .on('profile', '=', profile)
                                    )
                                    .where('username', '=', username)
                                    .selectAll()
                                    .executeTakeFirst();

                                if (!Environment.WEBSITE_REGISTRATION && !account) {
                                    // register the user automatically
                                    const insertResult = await db
                                        .insertInto('account')
                                        .values({
                                            username,
                                            password: hashSync(password.toLowerCase(), 10),
                                            registration_ip: remoteAddress,
                                            registration_date: toDbDate(new Date())
                                        })
                                        .executeTakeFirst();

                                    if (typeof insertResult.insertId === 'undefined') {
                                        return;
                                    }

                                    account = await db.selectFrom('account')
                                        .leftJoin('account_login', join => join
                                            .onRef('account_id', '=', 'id')
                                            .on('profile', '=', profile)
                                        )
                                        .where('username', '=', username)
                                        .selectAll()
                                        .executeTakeFirst();
                                }

                                if (!account || !(await compare(password.toLowerCase(), account.password))) {
                                    // invalid username or password
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 1
                                        })
                                    );
                                    return;
                                }

                                if (account.banned_until !== null && new Date(account.banned_until) > new Date()) {
                                    // account disabled
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 5
                                        })
                                    );
                                    return;
                                }

                                if (nodeMembers && !account.members) {
                                    if (Environment.NODE_AUTO_SUBSCRIBE_MEMBERS) {
                                        // Set members=1 for the account and proceed with login
                                        await db.updateTable('account').where('id', '=', account.id).set('members', 1).executeTakeFirstOrThrow();
                                        account.members = 1;
                                    } else {
                                        s.send(
                                            JSON.stringify({
                                                replyTo,
                                                response: 9
                                            })
                                        );
                                        return;
                                    }
                                }

                                if (
                                    !reconnecting &&
                                    account.logged_in === nodeId &&
                                    account.login_time !== null &&
                                    new Date(account.login_time).getTime() < Date.now() - Environment.NODE_HOP_TIME
                                ) {
                                    await db
                                        .updateTable('account_login')
                                        .set({
                                            logged_in: 0,
                                            login_time: null
                                        })
                                        .where('account_id', '=', account.id)
                                        .where('profile', '=', profile)
                                        .executeTakeFirst();

                                    account.logged_in = 0;
                                    account.login_time = null;
                                }

                                if (reconnecting && account.logged_in === nodeId) {
                                    await db
                                        .insertInto('session')
                                        .values({
                                            uuid: socket,
                                            account_id: account.id,
                                            profile,
                                            world: nodeId,
                                            timestamp: toDbDate(nodeTime),
                                            uid,
                                            ip: remoteAddress
                                        })
                                        .execute();

                                    if (!hasSave) {
                                        const save = await fsp.readFile(`data/players/${profile}/${username}.sav`);
                                        if (!save || !PlayerLoading.verify(new Packet(save))) {
                                            // Extreme safety check for savefile existing but having bad data on read:
                                            console.error('on reconnect, account_id %s had invalid save data on disk', account.id);
                                            this.rejectLoginForSafety(s, replyTo);
                                            return;
                                        }
                                        this.saveSessions.set(filename, { worldId, sessionId: socket, nodeId });
                                        this.saveOperations.delete(filename);
                                        s.send(
                                            JSON.stringify({
                                                replyTo,
                                                response: 2,
                                                account_id: account.id,
                                                staffmodlevel: account.staffmodlevel,
                                                muted_until: account.muted_until,
                                                save: save.toString('base64'),
                                                members: account.members,
                                                messageCount: 0
                                            })
                                        );
                                    } else {
                                        this.saveSessions.set(filename, { worldId, sessionId: socket, nodeId });
                                        this.saveOperations.delete(filename);
                                        s.send(
                                            JSON.stringify({
                                                replyTo,
                                                response: 2,
                                                account_id: account.id,
                                                staffmodlevel: account.staffmodlevel,
                                                muted_until: account.muted_until,
                                                members: account.members,
                                                messageCount: 0
                                            })
                                        );
                                    }
                                    return;
                                } else if (account.logged_in !== null && account.logged_in !== 0) {
                                    // already logged in elsewhere
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 3
                                        })
                                    );
                                    return;
                                } else if (
                                    account.staffmodlevel < 2 &&
                                    account.logged_out !== 0 &&
                                    account.logged_out !== nodeId &&
                                    account.logout_time !== null
                                ) {
                                    const remaining = new Date(account.logout_time).getTime() - new Date(Date.now() - Environment.NODE_HOP_TIME).getTime();
                                    if (remaining > 0) {
                                        // rate limited (hop timer)
                                        s.send(
                                            JSON.stringify({
                                                replyTo,
                                                response: 10,
                                                remaining
                                            })
                                        );
                                        return;
                                    }
                                }

                                await db
                                    .insertInto('session')
                                    .values({
                                        uuid: socket,
                                        account_id: account.id,
                                        profile,
                                        world: nodeId,
                                        timestamp: toDbDate(nodeTime),
                                        uid,
                                        ip: remoteAddress
                                    })
                                    .execute();

                                if (!fs.existsSync(`data/players/${profile}/${username}.sav`)) {
                                    // not an error - never logged in before
                                    // ^ Only not an error if the user has never logged in before:
                                    if (account.logout_time !== null) {
                                        console.error('on login, account_id %s had no save data on disk!', account.id);
                                        this.rejectLoginForSafety(s, replyTo);
                                        return;
                                    } else {
                                        s.send(
                                            JSON.stringify({
                                                replyTo,
                                                response: 4,
                                                account_id: account.id,
                                                staffmodlevel: account.staffmodlevel,
                                                muted_until: account.muted_until,
                                                messageCount: 0
                                            })
                                        );
                                    }
                                } else {
                                    const save = await fsp.readFile(`data/players/${profile}/${username}.sav`);
                                    // Extreme safety check for savefile existing but having bad data on read:
                                    if (!save || !PlayerLoading.verify(new Packet(save))) {
                                        console.error('on login, account_id %s had invalid save data on disk!', account.id);
                                        this.rejectLoginForSafety(s, replyTo);
                                        return;
                                    }
                                    s.send(
                                        JSON.stringify({
                                            replyTo,
                                            response: 0,
                                            account_id: account.id,
                                            staffmodlevel: account.staffmodlevel,
                                            save: save.toString('base64'),
                                            muted_until: account.muted_until,
                                            members: account.members,
                                            messageCount: 0
                                        })
                                    );
                                }

                                // Login is valid - update account table
                                if (account.account_id) {
                                    await db.updateTable('account_login')
                                        .set({
                                            logged_in: nodeId,
                                            login_time: toDbDate(new Date())
                                        })
                                        .where('account_id', '=', account.id)
                                        .where('profile', '=', profile)
                                        .executeTakeFirst();
                                } else {
                                    await db.insertInto('account_login')
                                        .values({
                                            account_id: account.id,
                                            profile: profile,
                                            logged_in: nodeId,
                                            login_time: toDbDate(new Date())
                                        })
                                        .executeTakeFirst();
                                }
                                this.saveSessions.set(filename, { worldId, sessionId: socket, nodeId });
                                this.saveOperations.delete(filename);
                            });
                        } finally {
                            this.loginRequests.delete(safeName);
                        }
                    } else if (type === 'player_logout' || type === 'player_autosave') {
                        const { replyTo, username, save, saveId, sessionId } = msg;
                        try {
                            await withPlayerSaveLock(filename, async () => {
                                assertCurrentWorld();
                                let owner = this.saveSessions.get(filename);
                                const account = await db.selectFrom('account')
                                    .leftJoin('account_login', join => join.onRef('account_id', '=', 'id').on('profile', '=', profile))
                                    .where('username', '=', username).selectAll().executeTakeFirst();
                                // Headless bots never authenticate through LoginClient.
                                // Their owner is the announced world incarnation, not a
                                // client-controllable replacement for a human session.
                                if (!owner && account?.password === '!bot' && !account.logged_in) {
                                    owner = { worldId, sessionId, nodeId };
                                    this.saveSessions.set(filename, owner);
                                }
                                if (!owner || owner.worldId !== worldId || owner.sessionId !== sessionId) throw new Error('Stale save session');
                                if (checkSaveOperation(msg, this.saveOperations.get(filename))) return;
                                const operation = { saveId, saveSequence: msg.saveSequence, sessionId, completed: false };
                                this.saveOperations.set(filename, operation);
                                const raw = Buffer.from(save, 'base64');
                                if (!PlayerLoading.verify(new Packet(raw)) || await this.wouldResetSaveFile(raw, profile, username)) {
                                    throw new Error(`${username}: Invalid or regressing save file`);
                                }
                                await writePlayerSave(filename, raw);
                                if (type === 'player_logout') {
                                    await updateHiscores(account, PlayerLoading.load(username, new Packet(raw), null), profile);
                                    if (account?.account_id) {
                                        await db.updateTable('account_login')
                                            .set({ logged_in: 0, login_time: null, logged_out: nodeId, logout_time: toDbDate(new Date()) })
                                            .where('account_id', '=', account.id).where('profile', '=', profile).executeTakeFirst();
                                    }
                                }
                                operation.completed = true;
                            });
                            if (type === 'player_logout') s.send(JSON.stringify({ replyTo, response: 0, saveId }));
                        } catch (err) {
                            console.error(err);
                            if (type === 'player_logout') s.send(JSON.stringify({ replyTo, response: 1, saveId }));
                        }
                    } else if (type === 'player_force_logout') {
                        const { username, sessionId } = msg;
                        await withPlayerSaveLock(filename, async () => {
                            assertCurrentWorld();
                            const owner = this.saveSessions.get(filename);
                            if (!owner || owner.worldId !== worldId || owner.sessionId !== sessionId) return;
                            const account = await db
                                .selectFrom('account')
                                .leftJoin('account_login', join => join
                                    .onRef('account_id', '=', 'id')
                                    .on('profile', '=', profile)
                                )
                                .where('username', '=', username)
                                .selectAll()
                                .executeTakeFirst();

                            if (account?.account_id) {
                                await db
                                    .updateTable('account_login')
                                    .set({
                                        logged_in: 0,
                                        login_time: null
                                    })
                                    .where('account_id', '=', account.id)
                                    .where('profile', '=', profile)
                                    .executeTakeFirst();
                            }
                        });
                    } else if (type === 'player_ban') {
                        const { _staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                banned_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();
                    } else if (type === 'player_mute') {
                        const { _staff, username, until } = msg;

                        // todo: audit log

                        await db
                            .updateTable('account')
                            .set({
                                muted_until: toDbDate(until)
                            })
                            .where('username', '=', username)
                            .executeTakeFirst();
                    }
                } catch (err) {
                    console.error(err);
                }
            });

            s.on('close', () => {});
            s.on('error', () => {});
        });
    }
}
