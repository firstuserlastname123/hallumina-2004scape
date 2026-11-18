import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { hashSync } from 'bcrypt-ts';
const { default: World } = await import('#/engine/World.js');
const { default: ClientSocket } = await import('#/server/ClientSocket.js');
const { default: Packet } = await import('#/io/Packet.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const central = process.argv[2] === 'central';
let server: any;
const db = new DatabaseSync('db.sqlite');
if (central) {
    const { default: LoginServer } = await import('#/server/login/LoginServer.js');
    server = new LoginServer();
    if (!server.server.address()) await once(server.server, 'listening');
    db.prepare("INSERT INTO account (username, password) VALUES ('admission', ?)").run(hashSync('test', 4));
    await (World as any).loginThread.terminate();
    (World as any).loginThread = new Worker('./src/server/login/LoginThread.ts', {
        execArgv: ['--import', new URL('../../src/engine/worker-bootstrap.mjs', import.meta.url).href],
        env: { ...process.env, LOGIN_SERVER: 'true', LOGIN_PORT: String(server.server.address().port) }
    });
    (World as any).loginThread.on('message', (msg: any) => World.onLoginMessage(msg));
}
const worker: Worker = (World as any).loginThread;
const listeners = new Set<(msg: any) => void>();
worker.on('message', msg => { for (const listener of listeners) listener(msg); });
function response(predicate: (msg: any) => boolean): Promise<any> {
    return new Promise(resolve => {
        const listener = (msg: any) => { if (predicate(msg)) { listeners.delete(listener); resolve(msg); } };
        listeners.add(listener);
    });
}
class Client extends ClientSocket {
    sent: number[] = [];
    constructor() { super(); this.remoteAddress = '127.0.0.1'; }
    send(raw: Uint8Array) { this.sent.push(...raw); }
    close() { this.state = -1; }
    terminate() { this.close(); }
}
await World.start(false, false);
async function propose(client: Client, reconnecting = false, admit = true) {
    World.loginRequests.set(client.uuid, client);
    const reply = response(msg => msg.type === 'player_login' && msg.socket === client.uuid);
    worker.postMessage({ type: 'player_login', username: 'admission', socket: client.uuid, password: 'test',
        remoteAddress: client.remoteAddress, uid: 1, lowMemory: false, reconnecting, hasSave: reconnecting });
    const result = await reply;
    if (admit) (World as any).processLogins();
    return result;
}
const filename = 'data/players/main/admission.sav';
async function saved(expected: Uint8Array, explanation: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
        try { if ((await fs.readFile(filename)).equals(Buffer.from(expected))) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(explanation);
}
async function autosave(player: any, explanation: string) {
    player.stats[0] += 100;
    const expected = player.save();
    (World as any).savePlayers();
    await saved(expected, explanation);
    if (central) {
        assert.equal(server.saveSessions.get(filename).sessionId, player.session);
        assert.equal(db.prepare('SELECT logged_in FROM account_login WHERE account_id=1').get()!.logged_in, 10);
    }
}
const first = new Client();
assert.equal((await propose(first)).reply, 4);
const player = World.getPlayerByUsername('admission')!;
assert.ok(player);
player.playtime = 100;
await autosave(player, 'initial admitted character could not save');
// A duplicate authentication reply for an already admitted socket is cleanup of
// a proposal, not authority to release the active character's DB login state.
World.onLoginMessage({ type: 'player_login', socket: first.uuid, username: player.username, reply: 4 } as any);
await autosave(player, 'late authentication reply invalidated an admitted character');
// Actual worker authentication followed by World duplicate rejection must not
// transfer ownership to the rejected socket.
const duplicate = new Client();
await propose(duplicate);
assert.equal(duplicate.state, -1);
assert.equal(World.getPlayerByUsername('admission'), player);
assert.equal(player.session, first.uuid);
await autosave(player, 'rejected duplicate login invalidated legitimate autosave ownership');
// Genuine reconnect keeps the same Player/progression, and commits the new socket
// only at World admission. The old session must then be fenced.
const reconnect = new Client();
let failedAdmission: Promise<any> | undefined;
if (central) {
    // An admission DB error must be retryable before the accepted socket's save.
    db.exec("CREATE TRIGGER fail_admission BEFORE UPDATE ON account_login WHEN NEW.login_time IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected admission failure'); END");
    failedAdmission = response(msg => msg.data?.sessionId === reconnect.uuid && msg.data?.response === 1);
}
await propose(reconnect, true);
if (central) {
    await failedAdmission;
    assert.equal(server.saveSessions.get(filename).sessionId, first.uuid);
    World.onLoginMessage({ type: 'player_login', socket: reconnect.uuid, username: player.username, reply: 2 } as any);
    db.exec('DROP TRIGGER fail_admission');
}
assert.equal(World.getPlayerByUsername('admission'), player);
assert.equal(player.session, reconnect.uuid);
assert.equal(first.state, -1);
await autosave(player, 'accepted reconnect did not acquire save ownership');
// Both authenticate against the same owner before World gets a chance to admit
// either. World accepts them consecutively; the final socket must still save.
const beforeQueuedReconnects = player.session;
const intermediateReconnect = new Client();
const finalReconnect = new Client();
await propose(intermediateReconnect, true, false);
await propose(finalReconnect, true, false);
assert.equal(World.newPlayers.size, 2);
assert.equal(player.session, beforeQueuedReconnects);
if (central) assert.equal(server.saveSessions.get(filename).sessionId, beforeQueuedReconnects);
const sendAdmission = worker.postMessage.bind(worker);
let finalAdmission: any;
const intermediateCommitted = central ? response(msg => msg.data?.sessionId === intermediateReconnect.uuid && msg.data?.response === 0) : undefined;
worker.postMessage = ((msg: any) => {
    if (central && msg.type === 'player_admit' && msg.sessionId === finalReconnect.uuid) finalAdmission = msg;
    else sendAdmission(msg);
}) as typeof worker.postMessage;
(World as any).processLogins();
worker.postMessage = sendAdmission;
if (central) {
    await intermediateCommitted;
    // A still-authenticated candidate cannot replace an owner using a stale
    // predecessor. Only the actual consecutive handoff is accepted.
    const wrongPredecessor = response(msg => msg.data?.sessionId === finalReconnect.uuid && msg.data?.response === 1);
    worker.postMessage({ ...finalAdmission, previousSessionId: beforeQueuedReconnects });
    await wrongPredecessor;
    assert.equal(server.saveSessions.get(filename).sessionId, intermediateReconnect.uuid);
    worker.postMessage(finalAdmission);
}
assert.equal(World.getPlayerByUsername('admission'), player);
assert.equal(player.session, finalReconnect.uuid);
assert.equal(intermediateReconnect.state, -1);
assert.equal(reconnect.state, -1);
await autosave(player, 'consecutive queued reconnects left the final admitted session unable to save');
if (central) {
    // A delayed admission retry for the intermediate socket must not undo the
    // final admission, even though that socket was once legitimately accepted.
    const staleAdmission = response(msg => msg.data?.sessionId === intermediateReconnect.uuid && msg.data?.response === 1);
    worker.postMessage({ type: 'player_admit', username: player.username, sessionId: intermediateReconnect.uuid,
        previousSessionId: beforeQueuedReconnects });
    await staleAdmission;
    await autosave(player, 'stale intermediate admission displaced the final reconnect');
}
const staleReply = response(msg => msg.type === 'player_logout' && msg.saveId === 'stale-socket');
worker.postMessage({ type: 'player_logout', username: player.username, sessionId: first.uuid,
    saveSequence: 100000, saveId: 'stale-socket', save: player.save() });
assert.equal((await staleReply).success, false);
// An unsuccessful logout must survive a subsequently rejected reconnect.
player.stats[0] += 100;
const post = worker.postMessage.bind(worker);
let corrupt = true;
worker.postMessage = ((msg: any) => {
    if (msg.type === 'player_logout' && corrupt) { corrupt = false; post({ ...msg, save: new Uint8Array([0]) }); }
    else post(msg);
}) as typeof worker.postMessage;
World.removePlayer(player);
const pending = World.logoutRequests.get(player.username)!;
const failed = response(msg => msg.type === 'player_logout' && msg.saveId === pending.saveId);
(World as any).processLogouts();
assert.equal((await failed).success, false);
assert.equal(World.logoutRequests.get(player.username), pending);
const duringLogout = new Client();
await propose(duringLogout, true);
assert.equal(duringLogout.state, -1);
assert.equal(World.logoutRequests.get(player.username), pending);
const retry = response(msg => msg.type === 'player_logout' && msg.saveId === pending.saveId);
pending.lastAttempt = -1;
(World as any).processLogouts();
assert.equal((await retry).success, true, 'rejected reconnect invalidated the pending logout owner');
assert.equal(World.logoutRequests.size, 0);
await saved(pending.save, 'logout retry did not preserve the pending snapshot');
// Admission must recheck pending persistence even when it appeared after the
// worker's authentication response had already enqueued the candidate.
const next = new Client();
await propose(next);
const nextPlayer = World.getPlayerByUsername('admission')!;
assert.ok(nextPlayer);
await autosave(nextPlayer, 'later accepted login could not save');
const queuedReconnect = new Client();
await propose(queuedReconnect, true, false);
assert.ok(World.newPlayers.size > 0);
World.removePlayer(nextPlayer);
const queuedSnapshot = World.logoutRequests.get(nextPlayer.username)!;
(World as any).processLogins();
assert.equal(queuedReconnect.state, -1);
const queuedRetry = response(msg => msg.type === 'player_logout' && msg.saveId === queuedSnapshot.saveId);
(World as any).processLogouts();
assert.equal((await queuedRetry).success, true, 'World admission rejection invalidated an enqueued logout');
assert.equal(World.logoutRequests.size, 0);
// Several authenticated proposals may share one login reservation. Rejecting
// all of them during shutdown must release it without changing the save owner.
const reserved = new Client();
await propose(reserved, false, false);
const reservedReconnect = new Client();
await propose(reservedReconnect, true, false);
World.shutdownTick = World.currentTick + 1;
(World as any).processLogins();
assert.equal(reserved.state, -1);
assert.equal(reservedReconnect.state, -1);
if (central) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (db.prepare('SELECT logged_in FROM account_login WHERE account_id=1').get()!.logged_in === 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(db.prepare('SELECT logged_in FROM account_login WHERE account_id=1').get()!.logged_in, 0, 'rejected proposals leaked their login reservation');
    assert.equal(server.saveSessions.get(filename).sessionId, nextPlayer.session);
}
World.shutdownTick = -1;
assert.equal(PlayerLoading.verify(new Packet(await fs.readFile(filename))), true);
console.log(`persistence admission ${central ? 'central' : 'local'} checks passed`);
process.exit(0);
