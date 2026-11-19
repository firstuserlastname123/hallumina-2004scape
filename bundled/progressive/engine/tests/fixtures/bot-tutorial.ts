import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const { default: World } = await import('#/engine/World.js');
const { default: Environment } = await import('#/util/Environment.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: VarPlayerType } = await import('#/cache/config/VarPlayerType.js');
const { default: Component } = await import('#/cache/config/Component.js');
const { default: ClientSocket } = await import('#/server/ClientSocket.js');
const { default: IfButton } = await import('#/network/game/client/model/IfButton.js');
const { default: IfButtonHandler } = await import('#/network/game/client/handler/IfButtonHandler.js');
const { default: IdkSaveDesign } = await import('#/network/game/client/model/IdkSaveDesign.js');
const { default: IdkSaveDesignHandler } = await import('#/network/game/client/handler/IdkSaveDesignHandler.js');
const { BotManager } = await import('#/engine/bot/BotManager.js');
const { BotLog } = await import('#/engine/bot/BotLog.js');
const { Items } = await import('#/engine/bot/BotKnowledge.js');
const { attachBotDialogue, answerBotDialogue } = await import('#/engine/bot/BotDialogue.js');
const { onTutorialIsland } = await import('#/engine/bot/BotTravel.js');
const { findNpcByName, interactNpcOp } = await import('#/engine/bot/BotAction.js');
const { PlayerStat } = await import('#/engine/entity/PlayerStat.js');
const { writePlayerSave } = await import('#/server/login/PlayerSave.js');
const { db } = await import('#/db/query.js');
import type Player from '#/engine/entity/Player.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';

let seed = 254;
Math.random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000;
};
await World.start(false, false);
assert.equal(Environment.ENGINE_REVISION, 254);
assert.equal(Environment.NODE_PRODUCTION, true);
const stage = VarPlayerType.getId('tutorial');
const bank = InvType.getId('bank');
assert.equal(VarPlayerType.get(stage).scope, VarPlayerType.SCOPE_PERM);
const savePath = (name: string) => `data/players/${Environment.NODE_PROFILE}/${name}.sav`;
const raw = (name: string) => fs.readFileSync(savePath(name));
const restore = process.argv[2] === 'restore';

function create(name: string) {
    return PlayerLoading.load(name, new Packet(new Uint8Array()), null);
}

function state(p: Player) {
    const items = (id: number) => p.getInventory(id)!.items.map(item => item && [item.id, item.count]);
    return {
        position: [p.x, p.z, p.level], body: p.body.slice(), colors: p.colors.slice(),
        xp: [...p.stats], stage: p.vars[stage], pending: p.botTutorialPending,
        inv: items(InvType.INV), worn: items(InvType.WORN), bank: items(bank)
    };
}

if (!restore) {
    // Legacy mainland and progressed island saves predate the pending marker.
    for (const [name, x, z, tutorial] of [
        ['sk1', 3218, 3218, 0], ['sk2', 3097, 3107, 4],
        ['sk3', 3094, 3106, 1], ['war1', 3093, 3491, 1000], ['ven1', 3186, 3438, 1000]
    ] as const) {
        const p = create(name);
        p.x = x; p.z = z;
        p.setVar(stage, tutorial);
        p.setLevel(PlayerStat.ATTACK, 42);
        p.setLevel(PlayerStat.WOODCUTTING, 18);
        p.invAdd(InvType.INV, Items.COINS, 321, false);
        p.invAdd(InvType.WORN, Items.IRON_SCIMITAR, 1, false);
        p.invAdd(bank, Items.COINS, 654, false);
        await writePlayerSave(savePath(name), p.save());
    }
    fs.writeFileSync(savePath('sk4'), Buffer.from([0, 0, 0]));
}

// Population runs use the entire configuration. Keep this restart fixture
// focused on the saves and roles under assertion.
const sample = new Set(['sk1', 'sk2', 'sk3', 'fi1', 'fi2', 'war1', 'war2', 'ven1']);
const manager = BotManager as unknown as {
    bots: Map<string, BotPlayer>;
    _spawnBot(config: { username: string }): void;
};
const spawnBot = manager._spawnBot.bind(manager);
manager._spawnBot = config => {
    if (sample.has(config.username) || config.username === 'sk4') spawnBot(config);
};
BotManager.init(World);
const { bots } = manager;
assert.equal(bots.has('sk4'), false, 'a damaged save cannot enroll as new');
assert.deepEqual([...raw('sk4')], [0, 0, 0]);
const fresh = bots.get('fi1')!;
const paused = bots.get('fi2')!;
const cohort = [...bots.values()];
assert.ok(fresh && paused);
assert.equal(fresh.player.botTutorialPending, !restore);
assert.equal(paused.player.botTutorialPending, true);
assert.equal(onTutorialIsland(fresh.player.x, fresh.player.z), !restore);

class MemoryClient extends ClientSocket {
    constructor() { super(); this.remoteAddress = '127.0.0.1'; this.state = 1; }
    send(_raw: Uint8Array) {}
    close() { this.state = -1; }
    terminate() { this.close(); }
}
async function admitHuman() {
    const client = new MemoryClient();
    World.loginRequests.set(client.uuid, client);
    const worker = (World as any).loginThread;
    const login = new Promise<number>(resolve => {
        const listener = (msg: any) => {
            if (msg.type !== 'player_login' || msg.socket !== client.uuid) return;
            worker.off('message', listener);
            resolve(msg.reply);
        };
        worker.on('message', listener);
    });
    worker.postMessage({ type: 'player_login', username: 'tuthuman', socket: client.uuid,
        password: 'test', uid: 1, remoteAddress: client.remoteAddress, lowMemory: false, reconnecting: false, hasSave: false });
    assert.equal(await login, 4);
    const player = [...World.newPlayers].find(p => p.username === 'tuthuman');
    assert.ok(player);
    attachBotDialogue(player);
    return player;
}
const human = restore ? create('tuthuman') : await admitHuman();

const cycle = World.cycle.bind(World);
World.cycle = () => {};
World.tickRate = 0;
const protectedBots = ['sk1', 'sk2', 'sk3', 'war1', 'ven1'].map(name => bots.get(name)!);
const preserved = new Map(protectedBots.map(bot => [bot, state(bot.player)]));
const arrivals = new Set<string>();
const talkedToGuide = new Set<string>();
const started = new Set<string>();
let freshPlanned = false;
for (const bot of cohort) {
    const queueTeleport = bot.setPendingTeleport.bind(bot);
    bot.setPendingTeleport = (x, z, level) => {
        assert.equal(bot.player.botTutorialPending, false, 'legacy recovery cannot move an enrolled bot');
        queueTeleport(x, z, level);
    };
    const runScript = bot.player.executeScript.bind(bot.player);
    bot.player.executeScript = (...args) => {
        const script = args[0];
        if (script.script.name === '[opnpc1,newbie_basics_instructor]') {
            assert.ok(script._activeNpc && bot.player.inOperableDistance(script._activeNpc));
            talkedToGuide.add(bot.name);
        }
        return runScript(...args);
    };
    const pick = bot.planner.pickTask.bind(bot.planner);
    bot.planner.pickTask = player => {
        assert.equal(player.botTutorialPending, false);
        assert.ok(!onTutorialIsland(player.x, player.z), 'ordinary activity on Tutorial Island');
        if (bot === fresh) freshPlanned = true;
        if (!started.has(bot.name)) {
            const expected = preserved.get(bot);
            if (expected) assert.deepEqual(state(player), expected);
            started.add(bot.name);
        }
        return pick(player);
    };
}
const botTick = BotManager.tick.bind(BotManager);
BotManager.tick = () => {
    botTick();
    for (const bot of cohort) {
        const p = bot.player;
        if (!p.isActive) continue;
        if (p.botTutorialPending) assert.equal(bot.currentTask, null);
        if (!restore && p.vars[stage] === 1000 && !p.botTutorialPending && bot.currentTask === null &&
            !protectedBots.includes(bot) && !arrivals.has(bot.name)) {
            assert.ok(talkedToGuide.has(bot.name));
            assert.deepEqual([p.x, p.z, p.level], [3222, 3222, 0]);
            assert.equal(p.invTotal(InvType.INV, Items.BRONZE_SWORD), 1);
            assert.equal(p.invTotal(InvType.INV, Items.SHRIMP), 1);
            assert.equal(p.invTotal(bank, Items.COINS), 25);
            assert.equal(p.baseLevels[PlayerStat.ATTACK], 1, 'profile setup ran before native arrival');
            arrivals.add(bot.name);
        }
    }
};
// Freeze one enrolled bot immediately after the native design checkpoint on the
// initial run. The normal engine logout flushes that unfinished character.
const pauseTick = paused.tick.bind(paused);
if (!restore) paused.tick = () => { if (paused.player.vars[stage] === 0) pauseTick(); };

let humanSpoke = false;
for (let i = 0; i < (restore ? 50 : 65); i++) {
    cycle();
    if (!restore && human.isActive) {
        if (human.allowDesign && human.modalMain === Component.getId('player_kit')) {
            assert.equal(new IdkSaveDesignHandler().handle(new IdkSaveDesign(human.gender, human.body, human.colors), human), true);
            new IfButtonHandler().handle(new IfButton(Component.getId('player_kit:accept')), human);
        } else if (human.activeScript) {
            assert.notEqual(human.modalChat, Component.getId('multi2'), 'production human received the skip choice');
            answerBotDialogue(human, /^$/);
        } else if (!humanSpoke && human.vars[stage] === 1) {
            const guide = findNpcByName(human.x, human.z, human.level, 'newbie_basics_instructor')!;
            assert.ok(guide);
            interactNpcOp(human, guide, 1);
            humanSpoke = true;
        }
    }
}
for (const bot of protectedBots.slice(1, 3)) {
    assert.equal(bot.currentTask, null, 'saved island progress must not enter the ordinary planner');
    assert.deepEqual(state(bot.player), preserved.get(bot));
}
for (const bot of protectedBots.filter(b => b.name === 'war1' || b.name === 'ven1')) {
    assert.deepEqual([...bot.player.stats], preserved.get(bot)!.xp);
    assert.equal(bot.player.invTotal(bank, Items.COINS), 654);
    assert.equal(bot.player.invTotal(InvType.WORN, Items.IRON_SCIMITAR), 1);
    assert.ok(bot.player.invTotal(InvType.INV, Items.COINS) >= 321);
}
assert.equal(fresh.player.vars[stage], 1000);
assert.equal(fresh.player.botTutorialPending, false);
assert.equal(freshPlanned, true);
if (restore) {
    assert.equal(paused.player.vars[stage], 1000);
    assert.equal(paused.player.botTutorialPending, false);
    assert.equal(BotLog.counts.tutorial_completed, 1, 'only the unfinished enrollment resumes');
    console.log('tutorial restart checks passed');
    process.exit(0);
}
assert.equal(paused.player.vars[stage], 1);
assert.equal(paused.player.botTutorialPending, true);
assert.equal(humanSpoke, true);
assert.equal(human.vars[stage], 4);
assert.equal(onTutorialIsland(human.x, human.z), true);
assert.equal(Environment.NODE_PRODUCTION, true);
assert.equal(arrivals.size, cohort.length - protectedBots.length - 1);
// Native starter inventories can change whether a specialist can switch gear.
const { EdgevillePKerTask } = await import('#/engine/bot/tasks/EdgevillePKerTask.js');
const { default: ObjType } = await import('#/cache/config/ObjType.js');
const equipProbe = create('equipprobe');
equipProbe.x = 3222; equipProbe.z = 3222;
World.newPlayers.add(equipProbe);
cycle();
const specWeapon = ObjType.getId('dragon_battleaxe');
assert.ok(specWeapon >= 0);
equipProbe.invAdd(InvType.INV, specWeapon, 1, false);
const attempt = new EdgevillePKerTask(false) as unknown as {
    profile: { specWeapon: number };
    useSpecial(player: Player, target: Player): boolean;
};
attempt.profile = { specWeapon };
const execute = equipProbe.executeScript.bind(equipProbe);
equipProbe.executeScript = (...args) => {
    assert.notEqual(args[0].script.name, '[if_button,combat_axe:specbar]');
    return execute(...args);
};
assert.equal(attempt.useSpecial(equipProbe, human), false, 'level-1 Attack cannot equip the special weapon');
assert.equal(equipProbe.invTotal(InvType.WORN, specWeapon), 0);
assert.equal(equipProbe.invTotal(InvType.INV, specWeapon), 1);
const accountsDeadline = Date.now() + 15_000;
while (Date.now() < accountsDeadline && (await db.selectFrom('account').where('password', '=', '!bot').where('username', 'in', [...sample]).select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow()).count !== cohort.length) await delay(10);
for (const bot of cohort) World.removePlayer(bot.player);
const deadline = Date.now() + 15_000;
while (World.logoutRequests.size > 0 && Date.now() < deadline) {
    await delay(10);
    (World as unknown as { processLogouts(): void }).processLogouts();
}
assert.equal(World.logoutRequests.size, 0);
assert.equal(raw('fi1').readUInt16BE(2), 7);
assert.equal(raw('fi2').readUInt16BE(2), 8);
assert.deepEqual([...raw('sk4')], [0, 0, 0]);
console.log('tutorial creation checks passed');
process.exit(0);
