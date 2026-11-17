import assert from 'node:assert/strict';
const { default: World } = await import('#/engine/World.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: NpcType } = await import('#/cache/config/NpcType.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { BotLog } = await import('#/engine/bot/BotLog.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { CraftingTask } = await import('#/engine/bot/tasks/CraftingTask.js');
const { CombatTask } = await import('#/engine/bot/tasks/CombatTask.js');
const { SkillProgression, Items } = await import('#/engine/bot/BotKnowledge.js');
const { PlayerStat, walkTo, findNpcByName, findNpcByNameExcluding } = await import('#/engine/bot/BotAction.js');
const { trimPathAtCsvBlock, validateBotPath } = await import('#/engine/bot/BotNavigation.js');
const { botWalkPath } = await import('#/engine/GameMap.js');
const rsmod = await import('@2004scape/rsmod-pathfinder');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function player(x = 3200, z = 3266) {
    const p = PlayerLoading.load(`regression${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x; p.z = z; p.level = 0; p.slot = serial;
    return p;
}
function bot(p = player()) {
    const b = new BotPlayer(p, new BotGoalPlanner());
    b.currentTask = { name: 'Test', interrupted: false, reset() {}, interrupt() { this.interrupted = true; },
        shouldRun() { return true; }, isComplete() { return false; }, tick() {} } as any;
    return b;
}

// Early subtask returns must capture the new route; delays must pause monitoring.
const sub = bot();
sub.setSubTask({ name: 'Test', interrupted: false, reset() {}, shouldRun() { return true; }, isComplete() { return false; },
    tick(p: any) { p.queueWaypoint(p.x + 1, p.z); } } as any);
sub.tick();
assert.equal((sub as any).lastHadWaypoints, true);
sub.player.delayed = true;
sub.tick();
assert.equal((sub as any).lastHadWaypoints, false);
assert.equal(sub.movementMonitor.getStuckTicks(), 0);

const stuck = bot();
stuck.player.queueWaypoint(stuck.player.x + 1, stuck.player.z);
stuck.tick();
const stuckBefore = BotLog.counts.navigation_stuck ?? 0;
for (let i = 0; i < 10; i++) stuck.tick();
assert.equal(BotLog.counts.navigation_stuck, stuckBefore + 1);
assert.equal(stuck.player.hasWaypoints(), false);
assert.equal(stuck.movementMonitor.isOscillating(), false);

// Four failures defer the task, preserving the personality weights and a timed retry.
const failed = bot();
const weights = JSON.stringify(failed.planner.personality.weights);
for (let i = 0; i < 4; i++) failed.navigationFailed('path_failed');
assert.equal(failed.currentTask!.interrupted, true);
assert.equal(failed.planner.isDeferred('Test', failed.player.playtime), true);
assert.equal(failed.planner.isDeferred('Test', failed.player.playtime + 200), false);
assert.equal(JSON.stringify(failed.planner.personality.weights), weights);
failed.planner.deferTask('Woodcut:1511', 200);
assert.equal(failed.planner.isDeferred('Woodcut:1521', 199), true);
failed.planner.deferTask('Mine', 200);
(failed.planner as any).initialised = true;
assert.equal((failed.planner as any)._buildCandidates(failed.player).includes('MINING'), false);
const requirements = bot();
requirements.currentTask!.shouldRun = () => false;
requirements.tick();
assert.equal(requirements.planner.isDeferred('Test', requirements.player.playtime), true);
const exception = bot();
exception.currentTask!.tick = () => { throw new Error('expected regression failure'); };
const errorOutput = console.error;
try { console.error = () => {}; exception.tick(); } finally { console.error = errorOutput; }
assert.equal(exception.currentTask!.interrupted, true);
assert.equal(exception.planner.isDeferred('Test', exception.player.playtime), true);

// Verify actual rsmod turn order and every segment, rather than treating turn points as steps.
for (let x = 5000; x < 5032; x++) for (let z = 5000; z < 5032; z++) rsmod.allocateIfAbsent(x, z, 0);
rsmod.changeLoc(5005, 5005, 0, 2, 5, false, false, true);
const route = botWalkPath(0, 5004, 5005, 5008, 5005);
assert.ok(route.length > 1);
assert.equal((route[route.length - 1] >> 14) & 0x3fff, 5008);
assert.equal(validateBotPath(0, 5004, 5005, route), 'ok');
const packed = (x: number, z: number) => (x << 14) | z;
const csv = BotCollisionMap as any;
const firstBlock = packed(5013, 5010);
csv.blocked.add(firstBlock);
assert.deepEqual(Array.from(trimPathAtCsvBlock(0, Uint32Array.of(packed(5016, 5010), packed(5016, 5016)), 5010, 5010)), [packed(5012, 5010)]);
csv.blocked.delete(firstBlock);
csv.blocked.add(packed(5010, 5011));
assert.equal(trimPathAtCsvBlock(0, Uint32Array.of(packed(5010, 5016)), 5010, 5010).length, 0);
csv.blocked.delete(packed(5010, 5011));
// Completely enclosed source: no blocked naive step or no-op path may be queued.
const enclosed = bot(player(5020, 5020));
rsmod.changeLoc(5019, 5019, 0, 3, 3, false, false, true);
walkTo(enclosed.player, 5028, 5028);
assert.equal(enclosed.player.hasWaypoints(), false);
assert.equal(enclosed.navigation.failures, 1);

// Searches ignore inactive NPCs and rotate live sheep when alternatives exist.
const firstSheep = findNpcByName(3200, 3266, 0, 'sheepunsheered', 20)!;
assert.ok(firstSheep);
const otherSheep = findNpcByNameExcluding(3200, 3266, 0, 'sheepunsheered', firstSheep.nid, 20)!;
assert.notEqual(otherSheep.nid, firstSheep.nid);
firstSheep.isActive = false;
assert.notEqual(findNpcByName(3200, 3266, 0, 'sheepunsheered', 20)?.nid, firstSheep.nid);
firstSheep.isActive = true;
const sheep = [...World.npcs].filter(npc => npc.type === firstSheep.type);
const originals = sheep.map(npc => npc.type);
for (const npc of sheep) npc.type = NpcType.getId('sheepsheered');
const woolStep = SkillProgression.CRAFTING.find(step => step.action === 'craft_wool')!;
function crafting() {
    const b = bot();
    b.player.getInventory(InvType.INV)!.add(Items.SHEARS, 1);
    const task = new CraftingTask(woolStep);
    b.currentTask = task;
    task.tick(b.player); // arrive -> shear
    return { b, task };
}
const absent = crafting();
const searchesBefore = BotLog.counts.resource_missing ?? 0;
const xpBefore = Array.from(absent.b.player.stats);
for (let i = 0; i < 160; i++) absent.task.tick(absent.b.player);
assert.equal(absent.task.interrupted, true);
assert.equal(absent.b.planner.isDeferred('Crafting', absent.b.player.playtime), true);
assert.ok((BotLog.counts.resource_missing ?? 0) - searchesBefore < 20);
assert.deepEqual(Array.from(absent.b.player.stats), xpBefore);
assert.equal(absent.b.player.getInventory(InvType.INV)!.contains(Items.WOOL), false);
const partial = crafting();
partial.b.player.getInventory(InvType.INV)!.add(Items.WOOL, 2);
for (let i = 0; i < 160; i++) partial.task.tick(partial.b.player);
assert.equal((partial.task as any).p1State, 'climb');
assert.equal(partial.task.interrupted, false);
const upstairs = crafting();
upstairs.b.player.getInventory(InvType.INV)!.add(Items.WOOL, 2);
const [wheelX, wheelZ, wheelLevel] = woolStep.location;
upstairs.b.player.x = wheelX + 2; upstairs.b.player.z = wheelZ; upstairs.b.player.level = wheelLevel;
(upstairs.task as any).p1State = 'spin';
let requestedFloor = -1;
const request = upstairs.b.navigation.request.bind(upstairs.b.navigation);
upstairs.b.navigation.request = (...args) => { requestedFloor = args[5]; return request(...args); };
upstairs.task.tick(upstairs.b.player);
assert.equal(requestedFloor, wheelLevel);
const regrowth = crafting();
for (let i = 0; i < 100; i++) regrowth.task.tick(regrowth.b.player);
firstSheep.type = originals[0];
for (let i = 0; i < 25 && !regrowth.b.player.hasInteraction(); i++) regrowth.task.tick(regrowth.b.player);
assert.equal(regrowth.b.player.hasInteraction(), true);
assert.equal(regrowth.b.player.target?.nid, firstSheep.nid);
for (let i = 0; i < sheep.length; i++) sheep[i].type = originals[i];

// A re-engage must not reset the overall approach budget or retry an unreachable NPC forever.
const fighter = bot(player(5001, 5001));
const fight = new CombatTask(SkillProgression.ATTACK[0], PlayerStat.ATTACK);
fighter.currentTask = fight;
const enemy = otherSheep;
const enemyPosition = { x: enemy.x, z: enemy.z };
World.gameMap.getZone(enemy.x, enemy.z, enemy.level).leave(enemy);
enemy.x = 5008; enemy.z = 5008;
World.gameMap.getZone(enemy.x, enemy.z, enemy.level).enter(enemy);
const state = fight as any;
state.state = 'interact'; state.currentNpc = enemy; state.lastXp = fighter.player.stats[PlayerStat.ATTACK];
state.interactTicks = 11; state.approachTicks = 11;
fight.tick(fighter.player);
assert.equal(state.approachTicks, 12);
for (let i = 0; i < 8; i++) fight.tick(fighter.player);
assert.equal(state.state, 'scan');
assert.equal(state.currentNpc, null);
assert.equal(state.unreachableNpcs.has(enemy.nid), true);
assert.equal(state._isNpcAvailable(enemy), false);
fighter.player.playtime += 100;
assert.equal(state._isNpcAvailable(enemy), true);
World.gameMap.getZone(enemy.x, enemy.z, enemy.level).leave(enemy);
enemy.x = enemyPosition.x; enemy.z = enemyPosition.z;
World.gameMap.getZone(enemy.x, enemy.z, enemy.level).enter(enemy);
console.log('runtime regression checks passed');
process.exit(0);
