import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { mock } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
const { default: World } = await import('#/engine/World.js');
const { default: LoginServer } = await import('#/server/login/LoginServer.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: ClientCheatHandler } = await import('#/network/game/client/handler/ClientCheatHandler.js');
const db = new DatabaseSync('db.sqlite');
db.exec("INSERT INTO account (username, password) VALUES ('persist', '!test'); INSERT INTO account_login (account_id, profile, logged_in) VALUES (1, 'main', 10)");
const server = new LoginServer() as any;
if (!server.server.address()) await once(server.server, 'listening');
const ws = new WebSocket(`ws://127.0.0.1:${server.server.address().port}`);
await once(ws, 'open');
const player = PlayerLoading.load('persist', new Packet(new Uint8Array()), null);
player.playtime = 100; player.stats[0] = 100000; player.baseLevels[0] = 30; player.levels[0] = 30;
const before = Buffer.from(player.save());
const filename = 'data/players/main/persist.sav';
let serial = 0;
const replies = new Map<number, (value: any) => void>();
ws.on('message', raw => { const msg = JSON.parse(String(raw)); replies.get(msg.replyTo)?.(msg); });
function send(raw: Uint8Array, type = 'player_logout') {
    const replyTo = ++serial;
    const result = new Promise<any>(resolve => replies.set(replyTo, resolve));
    ws.send(JSON.stringify({ type, replyTo, username: 'persist', profile: 'main', nodeId: 10, save: Buffer.from(raw).toString('base64') }));
    return result;
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
assert.notEqual((await send(player.save())).response, 0); stillLocked();
db.exec('DROP TRIGGER reject_hiscore');
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
// A reconnect after the hop timer must not discard a failed logout snapshot.
const { default: ClientSocket } = await import('#/server/ClientSocket.js');
class Client extends ClientSocket {
    sent: number[] = [];
    send(raw: Uint8Array) { this.sent.push(...raw); }
    close() {}
    terminate() {}
}
const pendingSave = { save: player.save(), lastAttempt: -1, createdAt: 0 };
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
