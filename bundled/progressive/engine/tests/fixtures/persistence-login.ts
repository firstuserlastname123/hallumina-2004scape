import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { hashSync } from 'bcrypt-ts';
import { randomUUID } from 'node:crypto';
const { default: World } = await import('#/engine/World.js');
const { default: LoginServer } = await import('#/server/login/LoginServer.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: ClientCheatHandler } = await import('#/network/game/client/handler/ClientCheatHandler.js');
const db = new DatabaseSync('db.sqlite');
db.prepare("INSERT INTO account (username, password) VALUES ('persist', ?)").run(hashSync('test', 4));
const server = new LoginServer() as any;
if (!server.server.address()) await once(server.server, 'listening');
const ws = new WebSocket(`ws://127.0.0.1:${server.server.address().port}`);
await once(ws, 'open');
const player = PlayerLoading.load('persist', new Packet(new Uint8Array()), null);
player.playtime = 100; player.stats[0] = 100000; player.baseLevels[0] = 30; player.levels[0] = 30;
const before = Buffer.from(player.save());
const filename = 'data/players/main/persist.sav';
let serial = 0;
let sequence = 0;
const worldId = 'test-world';
let sessionId = 'test-session';
const replies = new Map<number, (value: any) => void>();
ws.on('message', raw => { const msg = JSON.parse(String(raw)); replies.get(msg.replyTo)?.(msg); });
function rpc(msg: any) {
    const replyTo = ++serial;
    const result = new Promise<any>(resolve => replies.set(replyTo, resolve));
    ws.send(JSON.stringify({ replyTo, profile: 'main', nodeId: 10, nodeTime: Date.now(), worldId, ...msg }));
    return result;
}
ws.send(JSON.stringify({ type: 'world_startup', profile: 'main', nodeId: 10, worldId, worldStartedAt: 1 }));
async function login(socket: string) {
    const reply = await rpc({ type: 'player_login', username: 'persist', password: 'test', uid: 1, socket,
        remoteAddress: '127.0.0.1', reconnecting: false, hasSave: false, nodeMembers: false });
    if ([0, 2, 4].includes(reply.response)) assert.equal((await rpc({ type: 'player_admit', username: 'persist', sessionId: socket })).response, 0);
    return reply;
}
assert.equal((await login(sessionId)).response, 4);
function send(raw: Uint8Array, type = 'player_logout', operation = { saveId: randomUUID(), saveSequence: ++sequence, sessionId }) {
    return rpc({ type, username: 'persist', ...operation, save: Buffer.from(raw).toString('base64') });
}
assert.equal((await send(before)).response, 0);
assert.equal(db.prepare('SELECT value FROM hiscore_large WHERE account_id=1').get()!.value, player.stats.reduce((a, b) => a + b, 0));
const locked = () => db.exec('UPDATE account_login SET logged_in=10');
const stillLocked = () => assert.equal(db.prepare('SELECT logged_in FROM account_login').get()!.logged_in, 10);
locked();
const corrupt = Buffer.from(before); corrupt[10] ^= 1;
assert.notEqual((await send(corrupt)).response, 0); stillLocked();
player.playtime = 99;
assert.notEqual((await send(player.save())).response, 0); stillLocked();
assert.deepEqual(await fs.readFile(filename), before);
player.playtime = 101;
mock.method(fs, 'rename', async () => { throw new Error('injected rename failure'); });
assert.notEqual((await send(player.save())).response, 0); stillLocked();
mock.restoreAll();
assert.deepEqual(await fs.readFile(filename), before);
// A DB failure after successful file replacement must not release the session.
db.exec("CREATE TRIGGER reject_hiscore BEFORE UPDATE ON hiscore_large BEGIN SELECT RAISE(FAIL, 'injected DB failure'); END");
player.stats[0] += 100;
const failedOperation = { saveId: 'db-retry', saveSequence: ++sequence, sessionId };
assert.notEqual((await send(player.save(), 'player_logout', failedOperation)).response, 0); stillLocked();
db.exec('DROP TRIGGER reject_hiscore');
assert.equal((await send(player.save(), 'player_logout', failedOperation)).response, 0);
locked();
// Hold an autosave before rename; the final logout must queue behind it.
let release!: () => void;
let entered!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const entering = new Promise<void>(resolve => { entered = resolve; });
const rename = fs.rename.bind(fs);
let first = true;
mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (first) { first = false; entered(); await gate; }
    return rename(...args);
});
void send(player.save(), 'player_autosave');
await entering;
player.playtime = 102; player.stats[0] += 100;
let acknowledged = false;
const final = send(player.save()).then(reply => { acknowledged = true; return reply; });
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(acknowledged, false); stillLocked();
release();
assert.equal((await final).response, 0);
mock.restoreAll();
assert.deepEqual(await fs.readFile(filename), Buffer.from(player.save()));
assert.equal(db.prepare('SELECT logged_in FROM account_login').get()!.logged_in, 0);
assert.equal(db.prepare('SELECT value FROM hiscore_large WHERE account_id=1').get()!.value, player.stats.reduce((a, b) => a + b, 0));
// Retrying a successful operation must not re-run file or DB side effects.
const completed = { saveId: 'completed', saveSequence: ++sequence, sessionId };
assert.equal((await send(player.save(), 'player_logout', completed)).response, 0);
const committed = await fs.stat(filename);
db.exec("UPDATE account_login SET logout_time='2000-01-01 00:00:00'");
assert.equal((await send(player.save(), 'player_logout', completed)).response, 0);
assert.equal((await fs.stat(filename)).ino, committed.ino);
assert.equal(db.prepare('SELECT logout_time FROM account_login').get()!.logout_time, '2000-01-01 00:00:00');
// A new authenticated session fences older retries before it has saved anything.
sessionId = 'new-session';
assert.equal((await login(sessionId)).response, 0);
assert.notEqual((await send(player.save(), 'player_logout', completed)).response, 0);
stillLocked();
assert.equal((await fs.stat(filename)).ino, committed.ino);
player.stats[0] += 100; // same playtime deliberately defeats the old regression guard
const latest = { saveId: 'latest', saveSequence: ++sequence, sessionId };
const newerBytes = Buffer.from(player.save());
assert.equal((await send(newerBytes, 'player_logout', latest)).response, 0);
assert.notEqual((await send(before, 'player_logout', completed)).response, 0);
assert.deepEqual(await fs.readFile(filename), newerBytes);
// Old force-logout requests also cannot release the new session.
sessionId = 'third-session';
assert.equal((await login(sessionId)).response, 0);
void rpc({ type: 'player_force_logout', username: 'persist', sessionId: completed.sessionId });
// A replied request after it acts as a socket/character-lock barrier.
assert.notEqual((await send(before, 'player_logout', completed)).response, 0);
stillLocked();
// An older snapshot from this same live session is rejected after a newer one.
const oldCurrent = { saveId: 'older-current', saveSequence: ++sequence, sessionId };
assert.equal((await send(newerBytes, 'player_logout', oldCurrent)).response, 0);
player.stats[0] += 100;
const finalCurrent = { saveId: 'newer-current', saveSequence: ++sequence, sessionId };
assert.equal((await send(player.save(), 'player_logout', finalCurrent)).response, 0);
assert.notEqual((await send(newerBytes, 'player_logout', oldCurrent)).response, 0);
assert.deepEqual(await fs.readFile(filename), Buffer.from(player.save()));
// A login arriving during a logout must wait for file AND database completion.
sessionId = 'fourth-session';
assert.equal((await login(sessionId)).response, 0);
let openGate!: () => void, reachedRename!: () => void;
let writes = 0;
const hold = new Promise<void>(resolve => { openGate = resolve; });
const reached = new Promise<void>(resolve => { reachedRename = resolve; });
mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    writes++; reachedRename(); await hold; return rename(...args);
});
const draining = { saveId: 'draining', saveSequence: ++sequence, sessionId };
const logout = send(player.save(), 'player_logout', draining);
await reached;
const duplicateLogout = send(player.save(), 'player_logout', draining);
let loginReplied = false;
const waitingLogin = login('fifth-session').then(reply => { loginReplied = true; return reply; });
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(loginReplied, false);
openGate();
assert.equal((await logout).response, 0);
assert.equal((await duplicateLogout).response, 0);
assert.equal(writes, 1, 'queued retry repeated a completed save');
assert.equal((await waitingLogin).response, 0);
mock.restoreAll();
assert.notEqual((await send(player.save(), 'player_logout', draining)).response, 0);
stillLocked();
// Exercise LoginThread -> LoginClient -> real LoginServer, including echoed IDs.
const { Worker } = await import('node:worker_threads');
const wire = new Worker('./src/server/login/LoginThread.ts', {
    execArgv: ['--import', new URL('../../src/engine/worker-bootstrap.mjs', import.meta.url).href],
    env: { ...process.env, LOGIN_SERVER: 'true', LOGIN_PORT: String(server.server.address().port), NODE_ID: '11' }
});
db.prepare("INSERT INTO account (username, password, staffmodlevel) VALUES ('wiretest', ?, 3)").run(hashSync('test', 4));
function wireRequest(msg: any) {
    return new Promise<any>(resolve => {
        const onMessage = (reply: any) => {
            if (reply.type !== msg.type || (msg.type === 'player_logout' && reply.saveId !== msg.saveId)) return;
            wire.off('message', onMessage);
            resolve(reply);
        };
        wire.on('message', onMessage);
        wire.postMessage(msg);
    });
}
const authenticate = async (socket: string, reconnecting = false) => {
    const reply = await wireRequest({ type: 'player_login', username: 'wiretest', password: 'test', socket,
        uid: 1, remoteAddress: '127.0.0.1', lowMemory: false, reconnecting, hasSave: reconnecting });
    if ([0, 2, 4].includes(reply.reply)) wire.postMessage({ type: 'player_admit', username: 'wiretest', sessionId: socket });
    return reply;
};
assert.equal((await authenticate('wire-session-one')).reply, 4);
const wirePlayer = PlayerLoading.load('wiretest', new Packet(new Uint8Array()), null);
wirePlayer.playtime = 200;
const wireOld = { type: 'player_logout', username: 'wiretest', save: wirePlayer.save(), saveId: 'wire-old', saveSequence: 1, sessionId: 'wire-session-one' };
const firstReply = await wireRequest(wireOld);
assert.equal(firstReply.saveId, wireOld.saveId);
assert.equal(firstReply.success, true);
const wireFile = 'data/players/main/wiretest.sav';
const firstInode = (await fs.stat(wireFile)).ino;
assert.equal((await wireRequest(wireOld)).success, true);
assert.equal((await fs.stat(wireFile)).ino, firstInode);
assert.equal((await authenticate('wire-session-two')).reply, 0);
assert.equal((await wireRequest(wireOld)).success, false);
assert.equal(db.prepare("SELECT logged_in FROM account_login WHERE account_id=2").get()!.logged_in, 11);
// Successful socket reconnection must fence the previous socket as well.
assert.equal((await authenticate('wire-session-three', true)).reply, 2);
const expiredSession = { ...wireOld, saveId: 'expired-session', saveSequence: 2, sessionId: 'wire-session-two' };
assert.equal((await wireRequest(expiredSession)).success, false);
wirePlayer.stats[0] += 123;
const wireNew = { ...wireOld, saveId: 'wire-new', saveSequence: 3, sessionId: 'wire-session-three', save: wirePlayer.save() };
assert.equal((await wireRequest(wireNew)).success, true);
assert.equal((await wireRequest(wireOld)).success, false);
assert.deepEqual(await fs.readFile(wireFile), Buffer.from(wireNew.save));
// Missing correlation data is rejected rather than treated as a legacy success.
assert.equal((await wireRequest({ ...wireNew, saveId: undefined })).success, false);
await wire.terminate();
// LoginClient must reject a response belonging to another operation, even if
// the WebSocket request helper delivered response=0 for it.
const { LoginClient } = await import('#/server/login/LoginClient.js');
const client = new LoginClient(99) as any;
client.worldStartup = async () => {};
client.ws = {};
let captured: any;
client.wsr = { checkIfWsLive: () => true, fetchSync: async (msg: any) => {
    captured = msg; return { error: false, result: { response: 0, saveId: 'wrong-operation' } };
} };
assert.equal(await client.playerLogout('wiretest', wireNew.save, wireNew), false);
assert.equal(captured.saveId, wireNew.saveId);
assert.equal(captured.sessionId, wireNew.sessionId);
assert.equal(captured.saveSequence, wireNew.saveSequence);
// A previous world incarnation cannot submit saves after a newer startup.
ws.send(JSON.stringify({ type: 'world_startup', profile: 'main', nodeId: 10, worldId: 'replacement-world', worldStartedAt: 2 }));
assert.notEqual((await send(before, 'player_logout', finalCurrent)).response, 0);
assert.deepEqual(await fs.readFile(filename), Buffer.from(player.save()));
// Existing moderation messages do not carry profile/incarnation metadata.
// Their routing and permissions must remain unchanged by persistence fencing.
client.ws = ws;
const until = Date.now() + 60_000;
await client.playerBan('admin', 'wiretest', until);
await client.playerMute('admin', 'wiretest', until);
for (let attempt = 0; attempt < 100; attempt++) {
    const row = db.prepare("SELECT banned_until, muted_until FROM account WHERE username='wiretest'").get()!;
    if (row.banned_until && row.muted_until) break;
    await new Promise(resolve => setTimeout(resolve, 5));
}
assert.ok(db.prepare("SELECT banned_until FROM account WHERE username='wiretest'").get()!.banned_until);
assert.ok(db.prepare("SELECT muted_until FROM account WHERE username='wiretest'").get()!.muted_until);
// Headless bots are fenced by the announced world, without a player login.
db.exec("INSERT INTO account (username, password) VALUES ('wirebot', '!bot')");
const bot = PlayerLoading.load('wirebot', new Packet(new Uint8Array()), null);
bot.playtime = 300;
const botOperation = { type: 'player_logout', username: 'wirebot', worldId: 'replacement-world',
    saveId: 'bot-old', saveSequence: 1, sessionId: 'bot-session', save: Buffer.from(bot.save()).toString('base64') };
assert.equal((await rpc(botOperation)).response, 0);
bot.stats[0] += 123;
const botNew = { ...botOperation, saveId: 'bot-new', saveSequence: 2, save: Buffer.from(bot.save()).toString('base64') };
assert.equal((await rpc(botNew)).response, 0);
assert.notEqual((await rpc(botOperation)).response, 0);
assert.deepEqual(await fs.readFile('data/players/main/wirebot.sav'), Buffer.from(bot.save()));
// Restarting the world replaces the headless session; old incarnation retries
// cannot claim it again, even before the replacement bot's first save.
ws.send(JSON.stringify({ type: 'world_startup', profile: 'main', nodeId: 10, worldId: 'third-world', worldStartedAt: 3 }));
assert.notEqual((await rpc(botNew)).response, 0);
const restartedBot = { ...botNew, worldId: 'third-world', sessionId: 'restarted-bot', saveId: 'restarted-bot-save', saveSequence: 1 };
assert.equal((await rpc(restartedBot)).response, 0);
assert.notEqual((await rpc(botNew)).response, 0);
// A reconnect after the hop timer must not discard a failed logout snapshot.
const { default: ClientSocket } = await import('#/server/ClientSocket.js');
class Client extends ClientSocket {
    sent: number[] = [];
    send(raw: Uint8Array) { this.sent.push(...raw); }
    close() {}
    terminate() {}
}
const pendingSave = { save: player.save(), lastAttempt: -1, createdAt: 0, saveId: 'pending', saveSequence: 1, sessionId: 'pending-session' };
World.logoutRequests.set(player.username, pendingSave);
const reconnect = new Client();
World.loginRequests.set(reconnect.uuid, reconnect);
World.onLoginMessage({ type: 'player_login', username: player.username, socket: reconnect.uuid,
    reply: 0, lowMemory: false, reconnecting: false, save: before, account_id: 1, members: true });
assert.equal(World.logoutRequests.get(player.username), pendingSave);
assert.deepEqual(reconnect.sent, [5]);
World.newPlayers.add(player);
(World as any).processLogins();
assert.equal(World.logoutRequests.get(player.username), pendingSave);
World.logoutRequests.clear();
// Cancellation sends the native zero timer packet to every player.
const packets: any[] = [];
player.write = (msg: any) => { packets.push(msg); };
World.playerLoop.add(1n, player);
World.rebootTimer(100);
assert.equal(World.cancelReboot(), true);
assert.equal(packets.at(-1).ticks, 0);
player.unlink();
// Production command permissions, timer reset and refusal once draining starts.
const handler = new ClientCheatHandler();
const messages: string[] = [];
player.messageGame = (msg: string) => { messages.push(msg); };
for (const level of [0, 1, 2]) {
    player.staffModLevel = level; World.rebootTimer(100);
    handler.handle({ input: 'cancelreboot' } as any, player);
    assert.notEqual(World.shutdownTick, -1);
}
player.staffModLevel = 3;
handler.handle({ input: 'cancelreboot' } as any, player);
assert.equal(World.shutdownTick, -1);
World.rebootTimer(0);
assert.equal(World.cancelReboot(), false);
console.log('persistence login checks passed');
process.exit(0);
