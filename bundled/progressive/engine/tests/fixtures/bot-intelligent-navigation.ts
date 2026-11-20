import assert from 'node:assert/strict';
import * as rsmod from '@2004scape/rsmod-pathfinder';
let rng = 254;
Math.random = () => { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return rng / 0x100000000; };
const { default: World } = await import('#/engine/World.js');
const { default: LocType } = await import('#/cache/config/LocType.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: ScriptState } = await import('#/engine/script/ScriptState.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { findTileRoute, chooseReachable, findLocApproach, findNpcApproach, botPathCost, canBotTravel } = await import('#/engine/bot/BotNavigation.js');
const { walkTo, countItem, nearbyLocs, findReachableLoc, findLocByName } = await import('#/engine/bot/BotAction.js');
const { tryObstacle, pollObstacle, hasPendingObstacle } = await import('#/engine/bot/BotObstacles.js');
const { CombatTask } = await import('#/engine/bot/tasks/CombatTask.js');
const { MiningTask } = await import('#/engine/bot/tasks/MiningTask.js');
const { WoodcuttingTask } = await import('#/engine/bot/tasks/WoodcuttingTask.js');
const { PickupSpawnTask } = await import('#/engine/bot/tasks/PickupSpawnTask.js');
const { ShopTripTask } = await import('#/engine/bot/tasks/ShopTripTask.js');
const { SkillProgression, Items, Locations, Interfaces } = await import('#/engine/bot/BotKnowledge.js');
const { PlayerStat } = await import('#/engine/entity/PlayerStat.js');
const { nearestBank, advanceBankWalk } = await import('#/engine/bot/tasks/BotTaskBase.js');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function bot(x: number, z: number) {
    const p = PlayerLoading.load(`smart${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x; p.z = z; p.level = 0; p.slot = serial; p.moveSpeed = 1; p.runenergy = 0;
    const b = new BotPlayer(p, new BotGoalPlanner());
    b.currentTask = { name: 'Navigation', interrupted: false, reset() {}, interrupt() { this.interrupted = true; },
        shouldRun() { return true; }, isComplete() { return false; }, tick() {} } as any;
    return b;
}
function tick(p: any) {
    World.currentTick++; p.playtime++; p.resetEntity(false);
    if (p.delayed && World.currentTick >= p.delayedUntil) p.delayed = false;
    if (!p.delayed && p.activeScript?.execution === ScriptState.SUSPENDED) p.executeScript(p.activeScript, true, true);
    p.processQueues(); p.processTimers(0); p.processTimers(1); p.processEngineQueue(); p.processInteraction();
}
const failures: string[] = [];
function check(name: string, fn: () => void) {
    try { fn(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, error); }
}
check('exact reachability rejects move-near and cost prefers a reachable alternative', () => {
    for (let x = 5000; x < 5040; x++) for (let z = 5000; z < 5040; z++) rsmod.allocateIfAbsent(x, z, 0);
    const b = bot(5005, 5005);
    rsmod.changeLoc(5007, 5004, 0, 3, 3, false, false, true);
    rsmod.changeLoc(5008, 5005, 0, 1, 1, false, false, false);
    const enclosed = { x: 5008, z: 5005 }, alternative = { x: 5005, z: 5010 };
    assert.equal(findTileRoute(0, b.player.x, b.player.z, enclosed.x, enclosed.z), null);
    assert.equal(canBotTravel(0, b.player.x, b.player.z, enclosed.x, enclosed.z), false);
    assert.equal(canBotTravel(0, b.player.x, b.player.z, b.player.x, b.player.z), true);
    const choice = chooseReachable(b.player, [enclosed, alternative], t => findTileRoute(0, b.player.x, b.player.z, t.x, t.z));
    assert.equal(choice?.target, alternative);
    assert.equal(choice?.cost, 5);
    rsmod.changeLoc(5007, 5004, 0, 3, 3, false, false, false);
    assert.ok(findTileRoute(0, b.player.x, b.player.z, enclosed.x, enclosed.z), 'dynamic reopening must be visible immediately');
});
check('local routes avoid the native PLAYER blocker and respect its removal', () => {
    const b = bot(5020, 5020);
    rsmod.changePlayer(5021, 5020, 0, 1, true);
    try {
        const route = findTileRoute(0, 5020, 5020, 5023, 5020);
        assert.ok(route);
        assert.ok(botPathCost(5020, 5020, route.path) > 3);
        assert.equal(rsmod.canTravel(0, 5020, 5020, 1, 0, 1, rsmod.CollisionFlag.PLAYER, rsmod.CollisionType.NORMAL), false);
    } finally { rsmod.changePlayer(5021, 5020, 0, 1, false); }
    assert.equal(botPathCost(5020, 5020, findTileRoute(0, 5020, 5020, 5023, 5020)!.path), 3);
    void b;
});
check('resource selection skips an enclosed tree and chooses another native operating face', () => {
    const b = bot(3165, 3416);
    const oak = findLocByName(3161, 3416, 0, 'oaktree', 0)!;
    const candidates = nearbyLocs(b.player, 15, loc => LocType.get(loc.type).debugname === 'oaktree');
    assert.ok(candidates.length > 1);
    const best = findReachableLoc(b.player, 15, loc => candidates.includes(loc));
    assert.ok(best && findLocApproach(b.player, best));
    // CSV rejection is layered on top of native directional collision.
    const csv = BotCollisionMap as any;
    const blocked: number[] = [];
    for (let x = best.x - 1; x <= best.x + best.width; x++) for (let z = best.z - 1; z <= best.z + best.length; z++) {
        const packed = (x << 14) | z;
        if (!csv.blocked.has(packed)) { blocked.push(packed); csv.blocked.add(packed); }
    }
    try {
        const task = new WoodcuttingTask({ ...SkillProgression.WOODCUTTING[0], itemGained: Items.OAK_LOGS }) as any;
        const next = task._findTree(b.player);
        assert.ok(next && next !== best);
        assert.ok(findLocApproach(b.player, next));
    } finally { for (const packed of blocked) csv.blocked.delete(packed); }
    assert.ok(oak);
});
check('mining holds the selected rock and walks to its legal face', () => {
    const b = bot(3177, 3368);
    const task = new MiningTask(SkillProgression.MINING[0]) as any;
    b.currentTask = task; task.state = 'approach';
    const rock = task._findRock(b.player);
    assert.ok(rock);
    const route = findLocApproach(b.player, rock)!;
    assert.ok(route);
    task.tick(b.player);
    assert.equal(task.currentRock, rock);
    if (!b.player.inOperableDistance(rock)) {
        assert.equal(b.navigation.destinationLabel, `${route.x},${route.z},0`);
        assert.notEqual(b.navigation.destinationLabel, `${rock.x},${rock.z},0`);
    }
});
check('melee executes the verified approach in native client-route mode', () => {
    const b = bot(3101, 3511);
    const step = SkillProgression.ATTACK.find(step => step.extra?.npcType === 'man')!;
    const task = new CombatTask(step, PlayerStat.ATTACK) as any;
    b.currentTask = task; task.state = 'scan';
    const target = task._findTargetNpc(b.player);
    assert.ok(target);
    const route = findNpcApproach(b.player, target)!;
    assert.ok(route.path.length);
    task.tick(b.player);
    assert.equal(b.player.target, target);
    assert.ok(b.player.hasWaypoints(), 'Attack must retain the selector route');
    for (let i = 0; i < 8 && !b.player.inOperableDistance(target); i++) tick(b.player);
    assert.equal(b.player.inOperableDistance(target), true);
    const pending = b.player.target;
    task.tick(b.player);
    assert.equal(b.player.target, pending, 'a legal encounter must retain its native interaction');
    task.reset();
});
check('a long native door approach keeps its observed progress budget', () => {
    const b = bot(3203, 3200);
    const door = findLocByName(3202, 3169, 0, 'zanarisdoor', 0)!;
    const approach = findLocApproach(b.player, door)!;
    assert.ok(approach);
    assert.ok(botPathCost(b.player.x, b.player.z, approach.path) >= 25);
    assert.equal(tryObstacle(b.player, door, 1), true);
    for (let i = 0; i < 195 && hasPendingObstacle(b.player); i++) { tick(b.player); pollObstacle(b.player); }
    assert.equal(hasPendingObstacle(b.player), false);
    assert.equal(b.navigation.failures, 0);
    assert.deepEqual([b.player.x, b.player.z], [3202, 3169]);
});
check('bank stand selection rejects an unavailable local stand', () => {
    const b = bot(3092, 3246);
    assert.deepEqual(nearestBank(b.player), Locations.DRAYNOR_BANK);
    const csv = BotCollisionMap as any;
    const packed = (Locations.DRAYNOR_BANK[0] << 14) | Locations.DRAYNOR_BANK[1];
    const had = csv.blocked.has(packed); csv.blocked.add(packed);
    try {
        assert.notDeepEqual(nearestBank(b.player), Locations.DRAYNOR_BANK);
        assert.equal(advanceBankWalk(b.player, null), 'walk');
        assert.notEqual(b.navigation.destinationLabel, Locations.DRAYNOR_BANK.join(','));
    } finally { if (!had) csv.blocked.delete(packed); }
});
check('the Lumbridge north boundary does not reverse a mainland journey', () => {
    const b = bot(3212, 3237);
    (b.planner as any).pickTask = () => null;
    b.currentTask!.tick = () => walkTo(b.player, 3177, 3368);
    let recoveries = 0;
    const fail = b.navigationFailed.bind(b);
    b.navigationFailed = reason => { if (reason === 'oscillating') recoveries++; fail(reason); };
    let arrived = false;
    for (let i = 0; i < 800 && !b.currentTask?.interrupted; i++) {
        tick(b.player); b.tick(); (World as any).processZones();
        if (Math.max(Math.abs(b.player.x - 3177), Math.abs(b.player.z - 3368)) <= 2) { arrived = true; break; }
    }
    assert.equal(arrived, true, `stopped at ${b.player.x},${b.player.z}, failures=${b.navigation.failures}`);
    assert.equal(recoveries, 0);
    assert.equal((b as any).pendingTeleport, null);
});
check('ground-item routes hold an alternative and do not revisit a consumed via', () => {
    const b = bot(5005, 5005);
    const first = { coords: [5008, 5005, 0] as [number, number, number] };
    const next = { coords: [5030, 5005, 0] as [number, number, number], via: [5005, 5005, 0] as [number, number, number] };
    const task = new PickupSpawnTask(Items.KNIFE, [first, next]) as any;
    b.currentTask = task;
    task.tick(b.player);
    assert.equal(task.target, first);
    // A depleted first spawn must stay excluded when the walk state resumes.
    task.exclude(b.player);
    task.tick(b.player);
    assert.equal(task.target, next);
    assert.equal(task.viaDone, true);
    b.player.x = 5015; b.player.z = 5005; b.player.clearWaypoints();
    task.tick(b.player);
    assert.equal(task.target, next);
    assert.equal(b.navigation.destinationLabel, '5030,5005,0');
    assert.equal((b as any).pendingTeleport, null);
});
check('shops wait for the native interface and only purchase real stock', () => {
    const b = bot(3231, 3203);
    const task = new ShopTripTask('BOB_AXES', Items.BRONZE_AXE, 1, 1) as any;
    b.currentTask = task; task.state = 'find';
    b.player.getInventory(InvType.INV)!.add(Items.COINS, 100);
    task.tick(b.player);
    assert.equal(task.state, 'interact');
    task.tick(b.player); task.tick(b.player); task.tick(b.player);
    assert.equal(task.state, 'interact', 'three task calls without native processing must not fabricate a purchase');
    const before = countItem(b.player, Items.BRONZE_AXE);
    for (let i = 0; i < 40 && !task.isComplete(b.player) && !task.interrupted; i++) { tick(b.player); task.tick(b.player); }
    assert.equal(b.player.modalMain, Interfaces.SHOP);
    assert.equal(task.isComplete(b.player), true);
    assert.equal(countItem(b.player, Items.BRONZE_AXE), before + 1);
    const coins = countItem(b.player, Items.COINS);
    assert.ok(coins < 100 && coins > 0);
    const absent = new ShopTripTask('BOB_AXES', Items.RUNE_SCIMITAR, 1, 1) as any;
    b.currentTask = absent; absent.state = 'buy';
    absent.tick(b.player);
    assert.equal(b.player.getInventory(InvType.INV)!.contains(Items.RUNE_SCIMITAR), false);
    assert.equal(countItem(b.player, Items.COINS), coins);
});
if (failures.length) throw new Error(failures.join('; '));
console.log('intelligent navigation runtime regression checks passed');
process.exit(0);
