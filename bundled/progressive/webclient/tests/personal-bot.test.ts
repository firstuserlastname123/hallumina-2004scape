import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionRequest, GamePort, Observation } from '../src/bot/api/Types.js';
import { ScriptRunner } from '../src/bot/runtime/ScriptRunner.js';
import { ObjectiveStore } from '../src/bot/runtime/ObjectiveStore.js';
import { Recorder } from '../src/bot/runtime/Recorder.js';
import { ScriptRegistry } from '../src/bot/runtime/ScriptRegistry.js';
import { resolveSettings } from '../src/bot/runtime/Settings.js';
import { woodcutting } from '../src/bot/scripts/Woodcutting.js';
import { findApproach } from '../src/bot/adapter/collision.js';
function observation(): Observation {
    return { version: 1, sequence: 0, at: Date.now(), account: 'ordinary', ready: true, position: { x: 3102, z: 3240, level: 0 }, inventory: [{ slot: 0, id: 1351, name: 'Bronze axe', count: 1, options: [] }],
        equipment: [], skills: Array.from({ length: 21 }, () => ({ xp: 0, base: 1, level: 1 })), npcs: [], groundItems: [], interfaces: [], quests: {}, bank: null, animation: -1, moving: false, health: 10,
        objects: [{ id: 1276, name: 'Tree', options: ['Chop down'], x: 3081, z: 3265, level: 0, width: 1, length: 1 },
            { id: 2213, name: 'Bank booth', options: ['Use', 'Use-quickly'], x: 3091, z: 3245, level: 0, width: 1, length: 1 }] };
}
class FakeGame implements GamePort {
    s = observation(); requests: ActionRequest[] = []; accept = true;
    observe(): Observation { return structuredClone({ ...this.s, sequence: ++this.s.sequence, at: Date.now() }); }
    approach(tile: Observation['position']): Observation['position'] { return tile; }
    dispatch(r: ActionRequest) { this.requests.push(r); return { accepted: this.accept, reason: this.accept ? 'dispatch' : 'unreachable' }; }
    onManualCommand() { return () => {}; } dispose() {}
}
function fixture() {
    const values = new Map<string, string>(), storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
    const game = new FakeGame(), recorder = new Recorder(), store = new ObjectiveStore(storage, 'world1'), runner = new ScriptRunner(game, recorder, store);
    return { game, recorder, store, runner, storage, values };
}
const logItem = (slot: number) => ({ slot, id: 1511, count: 1, name: 'Logs', options: [] });
test('registry search, categories, duplicate protection and schema validation', () => {
    const registry = new ScriptRegistry(); registry.register(woodcutting);
    assert.equal(registry.list('banking', 'Skills').length, 1); assert.equal(registry.list('quest').length, 0);
    assert.throws(() => registry.register(woodcutting)); assert.throws(() => resolveSettings(woodcutting.settingsSchema, { target: Infinity }));
    assert.throws(() => resolveSettings(woodcutting.settingsSchema, { banking: 'yes' }));
});
test('native collision indexing respects walls and blocked destinations', () => {
    const flags = new Int32Array(104 * 104); const at = (x: number, z: number) => x * 104 + z;
    flags[at(6, 5)] = 0x100; assert.equal(findApproach(flags, { x: 5, z: 5 }, { x: 6, z: 5 }), null);
    flags.fill(0); for (let z = 1; z < 103; z++) flags[at(6, z)] = 0x100;
    assert.equal(findApproach(flags, { x: 5, z: 5 }, { x: 7, z: 5 }), null);
    assert.deepEqual(findApproach(flags, { x: 5, z: 5 }, { x: 4, z: 6 }), { x: 4, z: 6 });
});
test('tree selection skips an unreachable closer tree and keeps protected inventory', () => {
    const { game, runner } = fixture();
    game.s.objects.push({ ...game.s.objects[0], x: 3084, z: 3266 });
    game.approach = tile => tile?.x === 3081 ? null : tile;
    runner.start(woodcutting, {}); runner.pump();
    const action = game.requests.at(-1)!.action;
    assert.equal(action.kind, 'object'); assert.equal(action.kind === 'object' && action.tile.x, 3084);
    assert.equal(game.s.inventory[0].id, 1351);
});
test('a click is pending until both native logs and XP arrive; no repeated chop clicks', () => {
    const { game, runner } = fixture(); runner.start(woodcutting, {}); runner.pump();
    assert.equal(game.requests.length, 1); assert.equal(runner.lastResult?.state, 'dispatched');
    runner.pump(); assert.equal(runner.lastResult?.state, 'pending'); assert.equal(game.requests.length, 1);
    game.s.inventory.push(logItem(1)); runner.pump(); assert.equal(runner.pending, true);
    game.s.skills[8].xp = 25; game.s.animation = 879; runner.pump();
    assert.equal(runner.lastResult?.state, 'success'); assert.equal(runner.progress.gathered, 1); assert.equal(game.requests.length, 1);
});
test('full inventory banks only logs, confirms both inventories, closes bank and returns to tree', () => {
    const { game, runner } = fixture(); game.s.inventory.push(...Array.from({ length: 27 }, (_, i) => logItem(i + 1)));
    runner.start(woodcutting, {}); runner.pump(); assert.equal(game.requests.at(-1)?.action.kind, 'object');
    game.s.bank = []; runner.pump(); assert.deepEqual(game.requests.at(-1)?.action, { kind: 'deposit', id: 1511, slot: 1 });
    game.s.inventory.splice(1); runner.pump(); assert.equal(runner.progress.banked, 0, 'inventory loss alone is insufficient');
    game.s.bank = [{ ...logItem(0), count: 27 }]; runner.pump(); assert.equal(runner.progress.banked, 27); assert.equal(runner.progress.cycles, 1);
    assert.equal(game.requests.at(-1)?.action.kind, 'close-bank');
    game.s.bank = null; runner.pump(); const action = game.requests.at(-1)!.action;
    assert.equal(action.kind, 'object'); assert.equal(action.kind === 'object' && action.option, 'Chop down');
    assert.ok(game.s.inventory.some(i => i.id === 1351));
});
test('pause cancels pending work and manual control does not schedule later actions', () => {
    const { game, runner } = fixture(); runner.start(woodcutting, {}); runner.pump(); runner.pause('Manual command', false);
    assert.equal(runner.lastResult?.state, 'interrupted'); const count = game.requests.length;
    runner.pump(); assert.equal(game.requests.length, count); assert.equal(runner.state, 'paused');
    runner.resume(); runner.pump(); assert.equal(runner.state, 'running'); runner.stop(); assert.equal(runner.state, 'stopped');
});
test('pause obtains a fresh cancellation observation even after another observer reads state', () => {
    const { game, runner } = fixture(); runner.start(woodcutting, {}); runner.pump();
    game.observe(); game.observe(); runner.pause();
    const cancellation = game.requests.at(-1)!;
    assert.equal(cancellation.action.kind, 'walk'); assert.equal(cancellation.sequence, game.s.sequence);
    assert.equal(runner.state, 'paused');
});
test('native activity acknowledgement stops when control is paused', () => {
    const { game, runner } = fixture(); let acknowledgements = 0;
    Object.assign(game, { acknowledgeActivity: () => { acknowledgements++; } });
    runner.start(woodcutting, {}); runner.pump(); assert.equal(acknowledgements, 1);
    runner.pause(); runner.pump(); runner.pump(); assert.equal(acknowledgements, 1);
});
test('logout/account switch requires explicit resume by original account', () => {
    const { game, runner } = fixture(); runner.start(woodcutting, {}); game.s.ready = false; runner.pump(); assert.equal(runner.state, 'paused');
    game.s.ready = true; game.s.account = 'someoneelse'; assert.throws(() => runner.resume());
    game.s.account = 'ordinary'; runner.pump(); assert.equal(runner.state, 'paused'); runner.resume(); assert.equal(runner.state, 'running');
});
test('restored objectives reconcile a completed deposit without replaying it', () => {
    const { game, runner, store } = fixture(); runner.start(woodcutting, {}); runner.pause(); const saved = store.load('ordinary')!;
    game.s.bank = [{ ...logItem(0), count: 27 }]; const next = new ScriptRunner(game, new Recorder(), store);
    next.start(woodcutting, saved.settings, saved); next.pump(); assert.equal(game.requests.at(-1)?.action.kind, 'close-bank');
    assert.equal(game.requests.filter(r => r.action.kind === 'deposit').length, 0);
    assert.equal(store.load('differentaccount'), null);
});
test('preferences and objectives stay scoped by account/world and tolerate unavailable storage', () => {
    const { store, storage } = fixture(); store.savePreferences('ordinary', 'woodcutting', { target: 12 });
    assert.deepEqual(store.preferences('ordinary', 'woodcutting'), { target: 12 });
    assert.deepEqual(store.preferences('another', 'woodcutting'), {});
    assert.deepEqual(new ObjectiveStore(storage, 'world2').preferences('ordinary', 'woodcutting'), {});
    assert.equal(new ObjectiveStore(null, 'world1').load('ordinary'), null);
    assert.deepEqual(new ObjectiveStore(null, 'world1').preferences('ordinary', 'woodcutting'), {});
});
test('missing axe, protected full inventory and unavailable trees fail safely', () => {
    const f = fixture(); f.game.s.inventory = []; f.runner.start(woodcutting, {}); assert.equal(f.runner.state, 'error'); assert.equal(f.game.requests.length, 0);
    const g = fixture(); g.game.s.inventory = Array.from({ length: 28 }, (_, i) => ({ ...g.game.s.inventory[0], slot: i }));
    g.runner.start(woodcutting, {}); g.runner.pump(); assert.equal(g.runner.state, 'paused');
    const h = fixture(); h.game.s.position = { x: 3083, z: 3264, level: 0 }; h.game.s.objects = []; h.runner.start(woodcutting, {}); h.runner.pump(); assert.equal(h.game.requests.length, 0); assert.match(h.runner.status, /respawn/);
});
test('black axes use the native r254 Woodcutting level requirement', () => {
    const { game, runner } = fixture(); game.s.inventory[0].id = 1361; game.s.skills[8].level = 6;
    runner.start(woodcutting, {}); assert.equal(runner.state, 'error');
    game.s.skills[8].level = 11; runner.start(woodcutting, {}); assert.equal(runner.state, 'running');
});
test('bounded failures pause rather than looping forever', () => {
    const { game, runner } = fixture(); game.accept = false; runner.start(woodcutting, {});
    for (let i = 0; i < 12; i++) { game.s.objects[0].id++; runner.pump(); }
    assert.equal(runner.state, 'paused'); assert.equal(runner.retries, 3);
});
test('timeouts remain failures, and browser suspension and health loss yield control', () => {
    const f = fixture(); f.runner.start(woodcutting, {}); f.runner.pump(); const start = Date.now();
    for (let n = 1; n <= 76; n++) f.runner.pump(start + n * 600);
    assert.ok(f.runner.retries > 0); assert.notEqual(f.runner.lastResult?.state, 'success');
    const g = fixture(); g.runner.start(woodcutting, {}); g.runner.pump(Date.now() + 6000); assert.equal(g.runner.state, 'paused');
    const h = fixture(); h.runner.start(woodcutting, {}); h.game.s.health = 9; h.runner.pump(); assert.equal(h.runner.state, 'paused'); assert.match(h.runner.status, /Health/);
});
test('recorder is independent, opt-in, bounded and exports command/result evidence without client secrets', () => {
    const recorder = new Recorder(3), s = observation();
    recorder.record('manual-command', { kind: 'walk' }); assert.equal(recorder.count, 0);
    recorder.setEnabled(true); recorder.observe(s); s.inventory.push(logItem(1)); recorder.observe(structuredClone(s));
    for (let i = 0; i < 5; i++) recorder.record('manual-command', { kind: 'object', id: i });
    const exported = JSON.parse(recorder.export()); assert.equal(exported.events.length, 3); assert.ok(exported.dropped > 0);
    assert.doesNotMatch(recorder.export(), /password|loginPass|token/); recorder.clear(); assert.equal(recorder.count, 0);
});

test('Draynor selection excludes southern trees and trees close to visible hazards', () => {
    const { game, runner } = fixture();
    game.s.position = { x: 3078, z: 3265, level: 0 };
    game.s.objects.push({ ...game.s.objects[0], x: 3079, z: 3267 }, { ...game.s.objects[0], x: 3094, z: 3232 });
    game.s.npcs.push({ index: 1, name: 'Jail guard', x: 3087, z: 3265, level: 0, options: ['Attack'] });
    runner.start(woodcutting, {}); runner.pump();
    const action = game.requests.at(-1)!.action;
    assert.equal(action.kind, 'object'); assert.equal(action.kind === 'object' && action.tile.z, 3267);
});
test('nearby native Draynor threats yield before issuing a gathering command', () => {
    const { game, runner } = fixture();
    game.s.npcs.push({ index: 1, name: 'Dark wizard', ...game.s.position!, options: ['Attack'] });
    runner.start(woodcutting, {}); runner.pump();
    assert.equal(runner.state, 'paused'); assert.equal(game.requests.length, 0);
});

test('a full inventory outside bank visibility travels to the entrance before opening the bank', () => {
    const { game, runner } = fixture(); game.s.position = { x: 3080, z: 3272, level: 0 };
    const booth = game.s.objects[1]; game.s.objects = [];
    game.s.inventory.push(...Array.from({ length: 27 }, (_, i) => logItem(i + 1)));
    runner.start(woodcutting, {}); runner.pump();
    assert.deepEqual(game.requests.at(-1)!.action, { kind: 'walk', tile: { x: 3092, z: 3250, level: 0 } });
    runner.pump(); assert.equal(runner.lastResult?.state, 'pending'); assert.equal(game.requests.length, 1);
    game.s.position = { x: 3092, z: 3250, level: 0 }; game.s.objects = [booth]; runner.pump();
    const action = game.requests.at(-1)!.action; assert.equal(action.kind, 'object');
    assert.equal(action.kind === 'object' && action.option, 'Use-quickly');
});

test('a late native level-up interrupts pending gathering and continues without a timeout or false reward', () => {
    const { game, runner } = fixture(); runner.start(woodcutting, {}); runner.pump();
    game.s.interfaces = [{ id: 4275, text: 'Click here to continue', options: [], buttonType: 6 },
        { id: 4274, text: 'Congratulations, you just advanced a woodcutting level!', options: [], buttonType: 0 }];
    runner.pump();
    assert.equal(runner.recentResults.at(-1)?.state, 'interrupted');
    assert.equal(runner.lastResult?.action.kind, 'dialogue'); assert.equal(runner.progress.gathered, 0);
    assert.equal(runner.retries, 0); assert.equal(game.requests.filter(r => r.action.kind === 'object').length, 1);
    runner.pump(); assert.equal(game.requests.length, 2, 'Continuation is also verified before another command');
});
