import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mock } from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
const { default: World } = await import('#/engine/World.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const player = PlayerLoading.load('ackrace', new Packet(new Uint8Array()), null);
player.playtime = 100;
World.flushPlayer(player);
const first = World.logoutRequests.get(player.username)!;
// Assign only on the pre-fix implementation, to reproduce username-only matching.
first.saveId ??= 'first';
World.onLoginMessage({ type: 'player_logout', username: player.username, saveId: first.saveId, success: true });
assert.equal(World.logoutRequests.size, 0);
player.stats[0] += 100;
World.flushPlayer(player);
const second = World.logoutRequests.get(player.username)!;
second.saveId ??= 'second';
assert.notEqual(second.saveId, first.saveId);
World.onLoginMessage({ type: 'player_logout', username: player.username, saveId: first.saveId, success: true });
assert.equal(World.logoutRequests.get(player.username), second, 'delayed acknowledgement cleared the newer snapshot');
World.onLoginMessage({ type: 'player_logout', username: player.username, success: true } as any);
assert.equal(World.logoutRequests.get(player.username), second, 'uncorrelated acknowledgement cleared the newer snapshot');
World.rebootTimer(0);
const exit = mock.method(process, 'exit', () => undefined as never);
(World as any).processShutdown();
assert.equal(exit.mock.callCount(), 0, 'shutdown exited with a newer save outstanding');
// A retry must carry the same identity and sequence, not create a new operation.
const posted: any[] = [];
const worker = (World as any).loginThread;
mock.method(worker, 'postMessage', (msg: any) => { posted.push(msg); });
(World as any).processLogouts();
second.lastAttempt = -1;
(World as any).processLogouts();
assert.equal(posted.length, 2);
for (const msg of posted) {
    assert.equal(msg.saveId, second.saveId);
    assert.equal(msg.saveSequence, second.saveSequence);
    assert.equal(msg.sessionId, second.sessionId);
}
World.onLoginMessage({ type: 'player_logout', username: player.username, saveId: second.saveId, success: false });
assert.equal(World.logoutRequests.get(player.username), second);
World.onLoginMessage({ type: 'player_logout', username: player.username, saveId: second.saveId, success: true });
(World as any).processShutdown();
assert.equal(exit.mock.callCount(), 1);
mock.restoreAll();

// The actual standalone worker must echo IDs, skip successful duplicate writes,
// and reject older operations even when their playtime equals the newer save.
const local = new Worker('./src/server/login/LoginThread.ts', { execArgv: ['--import', new URL('../../src/engine/worker-bootstrap.mjs', import.meta.url).href] });
const errors: unknown[] = [];
local.on('error', err => errors.push(err));
function request(msg: any) {
    const response = once(local, 'message');
    local.postMessage(msg);
    return response.then(([reply]) => reply);
}
const oldSave = { type: 'player_logout', username: player.username, save: player.save(), saveId: 'local-old', saveSequence: 1, sessionId: 'local-session-old' };
assert.deepEqual(await request(oldSave), { type: 'player_logout', username: player.username, saveId: 'local-old', success: true });
const filename = `data/players/main/${player.username}.sav`;
const before = await fs.stat(filename);
assert.equal((await request(oldSave)).success, true);
assert.equal((await fs.stat(filename)).ino, before.ino, 'successful retry rewrote the file');
await request({ type: 'player_login', username: player.username, socket: 'local-session-new', lowMemory: false, reconnecting: false });
local.postMessage({ type: 'player_admit', username: player.username, sessionId: 'local-session-new' });
assert.equal((await request(oldSave)).success, true); // cached success; no session/database side effects
assert.equal((await fs.stat(filename)).ino, before.ino);
player.stats[0] += 100;
const newer = { ...oldSave, save: player.save(), saveId: 'local-new', saveSequence: 2, sessionId: 'local-session-new' };
assert.equal((await request(newer)).success, true);
assert.equal((await request(oldSave)).success, false);
assert.deepEqual(await fs.readFile(filename), Buffer.from(newer.save));
assert.equal((await request({ ...newer, saveId: undefined })).success, false);
assert.deepEqual(await fs.readFile(filename), Buffer.from(newer.save));
assert.deepEqual(errors, []);
await local.terminate();
console.log('persistence acknowledgement checks passed');
process.exit(0);
