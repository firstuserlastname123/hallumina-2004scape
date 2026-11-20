import assert from 'node:assert/strict';
let rng = 254;
Math.random = () => { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return rng / 0x100000000; };
const { default: World } = await import('#/engine/World.js');
const { default: LocType } = await import('#/cache/config/LocType.js');
const { default: ScriptState } = await import('#/engine/script/ScriptState.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { walkTo } = await import('#/engine/bot/BotAction.js');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function bot(x: number, z: number, level = 0) {
    const p = PlayerLoading.load(`smart${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x; p.z = z; p.level = level; p.slot = serial; p.moveSpeed = 1; p.runenergy = 0;
    const b = new BotPlayer(p, new BotGoalPlanner());
    b.currentTask = { name: 'Navigation', interrupted: false, reset() {}, interrupt() { this.interrupted = true; },
        shouldRun() { return true; }, isComplete() { return false; }, tick() {} } as any;
    return b;
}
function engineTick(p: any) {
    World.currentTick++; p.playtime++; p.resetEntity(false);
    if (p.delayed && World.currentTick >= p.delayedUntil) p.delayed = false;
    if (!p.delayed && p.activeScript?.execution === ScriptState.SUSPENDED) p.executeScript(p.activeScript, true, true);
    p.processQueues(); p.processTimers(0); p.processTimers(1); p.processEngineQueue(); p.processInteraction();
}

const failures: string[] = [];
function check(name: string, run: () => void) {
    try { run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, error); }
}
const routes: [string, number[], number[], string[]][] = [
    ['Lumbridge hall to Draynor bank', [3215,3218,0], [3092,3245,0], ['openbankdoor_l']],
    ['Lumbridge first floor exit', [3209,3213,1], [3218,3239,0], ['loc_1739']],
    ['Lumbridge second floor exit', [3205,3210,2], [3218,3239,0], ['loc_1740','loc_1739']],
    ['Lumbridge stair entrance', [3215,3218,0], [3205,3209,1], ['loc_1738']],
    ['Manor one-way entrance recovery', [3109,3354,0], [3223,3238,0], ['hauntedbackdoor']],
    ['Manor first floor exit', [3108,3367,1], [3223,3238,0], ['loc_1731','hauntedbackdoor']],
    ['Manor crypt exit', [3077,9771,0], [3223,3238,0], ['cryptstairsup','hauntedbackdoor']],
    ['Manor crypt entrance', [3109,3354,0], [3077,9771,0], ['cryptstairsdown']],
    ['Draynor Morgan house stairs', [3098,3266,1], [3105,3264,0], ['loc_1723']],
    ['Al Kharid upper ladders', [3285,3191,2], [3218,3239,0], ['loc_1746','loc_1748']],
    ['Wizards Tower cellar exit', [3107,9574,0], [3105,3161,0], ['wizards_tower_ladder']],
    ['Wizards Tower cellar entrance', [3105,3162,0], [3105,9576,0], ['wizards_tower_laddertop']],
];
for (const [name, start, goal, required] of routes) check(name, () => {
    const b = bot(start[0], start[1], start[2]), p = b.player;
    (b.planner as any).pickTask = () => null;
    const calls: string[] = [];
    const execute = p.executeScript.bind(p);
    p.executeScript = (...args) => {
        const state = args[0];
        if (!args[2] && /oploc[1-5],/.test(state.script.name) && state._activeLoc) calls.push(LocType.get(state._activeLoc.type).debugname!);
        return execute(...args);
    };
    const initialStats = Array.from(p.stats), initialVars = Array.from(p.vars);
    b.currentTask!.tick = () => walkTo(p, goal[0], goal[1], goal[2]);
    walkTo(p, goal[0], goal[1], goal[2]);
    assert.equal(calls.length, 0, 'route planning must queue a click, never execute content directly');
    const target = p.target;
    assert.ok(target);
    walkTo(p, goal[0], goal[1], goal[2]);
    assert.equal(p.target, target, 'an ongoing native click must survive repeated walk requests');
    let arrived = false;
    for (let i = 0; i < 1800 && !b.currentTask?.interrupted; i++) {
        engineTick(p); b.tick(); (World as any).processZones();
        assert.equal((b as any).pendingTeleport, null);
        if (p.x === goal[0] && p.z === goal[1] && p.level === goal[2]) { arrived = true; break; }
    }
    assert.equal(arrived, true, `stopped at ${p.x},${p.z},${p.level}; failures=${b.navigation.failures}; clicks=${calls}`);
    for (const name of required) assert.ok(calls.includes(name), `missing native ${name} click: ${calls}`);
    assert.ok(!calls.some(name => /^haunteddoor[lr]$/.test(name)), 'exit routes must not reenter the one-way front doors');
    assert.deepEqual(Array.from(p.stats), initialStats, 'navigation cannot award XP');
    assert.deepEqual(Array.from(p.vars), initialVars, 'navigation cannot fabricate quest progress');
});
if (failures.length) throw new Error(failures.join('; '));
console.log('native exit runtime regression checks passed');
process.exit(0);
