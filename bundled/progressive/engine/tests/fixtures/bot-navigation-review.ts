import assert from 'node:assert/strict';
const { default: World } = await import('#/engine/World.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { BotLog } = await import('#/engine/bot/BotLog.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { walkTo, interactLoc } = await import('#/engine/bot/BotAction.js');
const { botWalkPath } = await import('#/engine/GameMap.js');
const { validateBotPath } = await import('#/engine/bot/BotNavigation.js');
const { BankstandTask } = await import('#/engine/bot/tasks/BankstandTask.js');
const { Locations } = await import('#/engine/bot/BotKnowledge.js');
const { default: Loc } = await import('#/engine/entity/Loc.js');
const { default: LocType } = await import('#/cache/config/LocType.js');
const { EntityLifeCycle } = await import('#/engine/entity/EntityLifeCycle.js');
const { default: ServerTriggerType } = await import('#/engine/script/ServerTriggerType.js');
const rsmod = await import('@2004scape/rsmod-pathfinder');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function helper(name: string, tick: (p: any) => void = () => {}, isComplete = () => false): any {
    return { name, interrupted: false, reset() { this.interrupted = false; },
        interrupt() { this.interrupted = true; }, shouldRun() { return true; }, isComplete, tick };
}
function bot(x = 5001, z = 5012) {
    const p = PlayerLoading.load(`review${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x; p.z = z; p.level = 0; p.slot = serial;
    const b = new BotPlayer(p, new BotGoalPlanner());
    b.currentTask = helper('Parent');
    return b;
}
for (let x = 5000; x < 5040; x++) for (let z = 5000; z < 5040; z++) rsmod.allocateIfAbsent(x, z, 0);

// Repeated nearby requests preserve the actual queued route, without another BFS.
const traveller = bot();
let queued = 0;
let cleared = 0;
const queue = traveller.player.queueWaypoints.bind(traveller.player);
const clear = traveller.player.clearWaypoints.bind(traveller.player);
traveller.player.queueWaypoints = points => { queued++; queue(points); };
traveller.player.clearWaypoints = () => { cleared++; clear(); };
walkTo(traveller.player, 5010, 5012);
const originalRoute = Array.from(traveller.player.waypoints);
const originalIndex = traveller.player.waypointIndex;
const initialClears = cleared;
assert.equal(queued, 1);
for (let i = 0; i < 100; i++) walkTo(traveller.player, 5010 + i % 3 - 1, 5012 + (i * 2) % 3 - 1);
assert.equal(queued, 1);
assert.equal(cleared, initialClears);
assert.equal(traveller.player.waypointIndex, originalIndex);
assert.deepEqual(Array.from(traveller.player.waypoints), originalRoute);
// Larger legitimate changes still retarget and complete with native movement.
walkTo(traveller.player, 5010, 5001);
assert.equal(queued, 2);
for (let i = 0; i < 60 && traveller.player.hasWaypoints(); i++) {
    traveller.player.walkDir = -1; traveller.player.runDir = -1;
    traveller.player.processMovement();
    traveller.tick();
}
assert.deepEqual([traveller.player.x, traveller.player.z], [5010, 5001]);
assert.equal(traveller.navigation.failures, 0);

// A slowly moving destination is coalesced locally and followed after each route ends.
const follower = bot(5001, 5016);
for (let i = 0; i < 40; i++) {
    walkTo(follower.player, 5008 + Math.min(6, Math.floor(i / 4)), 5016);
    follower.player.walkDir = -1; follower.player.runDir = -1;
    follower.player.processMovement();
    follower.tick();
}
assert.deepEqual([follower.player.x, follower.player.z], [5014, 5016]);
assert.equal(follower.currentTask!.interrupted, false);

// Exercise the review's exact Bankstand.handleWalk trigger on a real valid route.
const [fireX, fireZ] = Locations.FIRE_VARROCK_ROAD;
const trader = bot(fireX - 8, fireZ);
const tradePath = botWalkPath(0, trader.player.x, trader.player.z, fireX, fireZ);
assert.ok(tradePath.length > 0);
assert.equal(validateBotPath(0, trader.player.x, trader.player.z, tradePath), 'ok');
trader.navigation.request(trader.player.x, trader.player.z, 0, fireX, fireZ, 0);
trader.player.queueWaypoints(tradePath);
const tradingRoute = Array.from(trader.player.waypoints);
let tradeRepaths = 0;
trader.player.queueWaypoints = () => { tradeRepaths++; };
const bankstand = new BankstandTask();
for (let i = 0; i < 100; i++) (bankstand as any).handleWalk(trader.player);
assert.equal(tradeRepaths, 0);
assert.deepEqual(Array.from(trader.player.waypoints), tradingRoute);

// Pending native gate interactions survive even a large destination change.
const gateBot = bot();
const gateType = LocType.getId('ctratgatea');
assert.notEqual(gateType, -1);
const gate = new Loc(0, 5008, 5012, 1, 1, EntityLifeCycle.FOREVER, gateType, 0, 0);
gate.isActive = true;
interactLoc(gateBot.player, gate);
gateBot.player.queueWaypoint(5007, 5012);
walkTo(gateBot.player, 5030, 5030);
assert.equal(gateBot.player.target, gate);
assert.equal(gateBot.player.targetOp, ServerTriggerType.APLOC1);
assert.equal(gateBot.player.hasWaypoints(), true);

// An unreachable child exhausts its own budget despite random destinations.
rsmod.changeLoc(5019, 5019, 0, 3, 3, false, false, true);
const childBot = bot(5020, 5020);
let parentTicks = 0;
let childTicks = 0;
childBot.currentTask!.tick = () => { parentTicks++; };
childBot.navigation.fail(0); childBot.navigation.fail(0);
const messages: string[] = [];
const childLog = childBot.log.bind(childBot);
childBot.log = (msg, level, key) => { messages.push(msg); childLog(msg, level, key); };
const blockedChild = helper('BlockedChild', p => {
    walkTo(p, 5028 + childTicks++ % 3 - 1, 5028);
    if (blockedChild.interrupted) walkTo(p, 5001, 5012); // no route from aborted work
});
const parentDeferrals = BotLog.counts.task_deferred ?? 0;
const childDeferrals = BotLog.counts.subtask_deferred ?? 0;
assert.equal(childBot.setSubTask(blockedChild), true);
for (let i = 0; i < 100 && (childBot as any).subTask; i++) {
    assert.equal(childBot.setSubTask(helper('BlockedChild')), false);
    childBot.tick();
}
assert.equal((childBot as any).subTask, null);
assert.equal(blockedChild.interrupted, true);
assert.equal(childBot.currentTask!.interrupted, false);
assert.equal(childBot.planner.isDeferred('Parent', childBot.player.playtime), false);
assert.equal(BotLog.counts.task_deferred ?? 0, parentDeferrals);
assert.equal(BotLog.counts.subtask_deferred, childDeferrals + 1);
assert.equal(childBot.navigation.failures, 2);
assert.equal(childBot.player.hasWaypoints(), false);
assert.equal(messages.filter(msg => msg.includes('[Navigation] path_failed')).length, 4);
assert.ok(messages.filter(msg => msg.includes('[Navigation] path_failed')).every(msg => msg.includes('task=BlockedChild')));
assert.equal(childBot.setSubTask(helper('RenamedChild')), false); // parent gets a turn first
childBot.tick();
assert.ok(parentTicks > 0);
assert.equal(childBot.setSubTask(helper('BlockedChild')), false);
for (let i = 0; i < 200; i++) childBot.tick();
assert.equal(childBot.setSubTask(helper('BlockedChild')), true);
(childBot as any).subTask.interrupt();
const resumedTicks = parentTicks;
childBot.tick();
assert.equal(parentTicks, resumedTicks + 1);
assert.equal((childBot as any).subTask, null);

// Successful temporary work resumes the parent and pauses its navigation clock.
const completionBot = bot();
let completedCalls = 0;
let resumed = 0;
completionBot.currentTask!.tick = () => { resumed++; };
completionBot.navigation.request(5001, 5012, 0, 5030, 5012, 0, 0);
completionBot.navigation.fail(0);
completionBot.setSubTask(helper('Temporary', () => { completedCalls++; }, () => completedCalls === 150));
for (let i = 0; i < 151; i++) completionBot.tick();
assert.equal(completedCalls, 150);
assert.equal(resumed, 1);
assert.equal(completionBot.currentTask!.interrupted, false);
assert.equal(completionBot.navigation.failures, 1);
assert.equal(completionBot.navigation.isStalled(completionBot.ticksAliveValue), false);

// Repeated scheduling attempts cannot reset a non-completing child's deadline.
const endlessBot = bot();
let endlessCalls = 0;
let parentResumed = 0;
endlessBot.currentTask!.tick = () => { parentResumed++; };
endlessBot.setSubTask(helper('Endless', () => { endlessCalls++; }));
for (let i = 0; i < 301; i++) {
    assert.equal(endlessBot.setSubTask(helper('Endless')), false);
    endlessBot.tick();
}
assert.equal(endlessCalls, 300);
assert.equal(parentResumed, 1);
assert.equal((endlessBot as any).subTask, null);

// Exceptions in child guards release priority without interrupting the parent.
const guardBot = bot();
const badGuard = helper('BadGuard');
badGuard.isComplete = () => { throw new Error('expected child guard failure'); };
guardBot.setSubTask(badGuard);
const priorError = console.error;
try { console.error = () => {}; guardBot.tick(); } finally { console.error = priorError; }
assert.equal((guardBot as any).subTask, null);
assert.equal(guardBot.currentTask!.interrupted, false);

// An interrupted parent hands control back to the goal planner, not to its child.
const interruptedParent = bot();
let abandonedChildCalls = 0;
interruptedParent.setSubTask(helper('Abandoned', () => { abandonedChildCalls++; }));
interruptedParent.currentTask!.interrupt();
assert.equal(interruptedParent.setSubTask(helper('Replacement')), false);
interruptedParent.tick();
assert.equal(abandonedChildCalls, 0);
assert.equal((interruptedParent as any).subTask, null);
assert.equal(interruptedParent.currentTask!.name, 'Init');

// Children without a parent also yield to the planner after bounded navigation failure.
const orphan = bot(5020, 5020);
orphan.currentTask = null;
orphan.setSubTask(helper('Orphan', p => { walkTo(p, 5028, 5028); }));
for (let i = 0; i < 100 && (orphan as any).subTask; i++) orphan.tick();
orphan.tick();
assert.equal((orphan as any).subTask, null);
assert.ok(orphan.currentTask);
assert.equal(orphan.currentTask!.name, 'Init');

// A dynamic obstruction can clear during backoff and subsequent movement succeeds.
const dynamic = bot(5020, 5020);
walkTo(dynamic.player, 5028, 5028);
assert.equal(dynamic.navigation.failures, 1);
rsmod.changeLoc(5019, 5019, 0, 3, 3, false, false, false);
dynamic.currentTask!.tick = p => { walkTo(p, 5028, 5028); };
for (let i = 0; i < 4; i++) dynamic.tick();
assert.equal(dynamic.player.hasWaypoints(), true);
for (let i = 0; i < 20 && (dynamic.player.x !== 5028 || dynamic.player.z !== 5028); i++) {
    dynamic.player.walkDir = -1; dynamic.player.runDir = -1;
    dynamic.player.processMovement();
    dynamic.tick();
}
assert.deepEqual([dynamic.player.x, dynamic.player.z], [5028, 5028]);
assert.equal(dynamic.navigation.failures, 0);
console.log('runtime regression checks passed: jitter, native routes, gates, subtasks and resumption');
process.exit(0);
