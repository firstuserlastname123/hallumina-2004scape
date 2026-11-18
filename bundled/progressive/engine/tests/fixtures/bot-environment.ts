import assert from 'node:assert/strict';
const { default: World } = await import('#/engine/World.js');
const { default: LocType } = await import('#/cache/config/LocType.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { openNearbyGate, walkTo, findLocByName, isAdjacentToLoc, interactLocOp } = await import('#/engine/bot/BotAction.js');
const { isMapBlocked, botFindPath } = await import('#/engine/GameMap.js');
const { SocialTask } = await import('#/engine/bot/tasks/SocialTask.js');
const { WoodcuttingTask } = await import('#/engine/bot/tasks/WoodcuttingTask.js');
const { ProgressWatchdog } = await import('#/engine/bot/tasks/BotTaskBase.js');
const { AgilityTask } = await import('#/engine/bot/tasks/AgilityTask.js');
const { default: ScriptState } = await import('#/engine/script/ScriptState.js');
const { hasPendingObstacle, pollObstacle } = await import('#/engine/bot/BotObstacles.js');
const { findLocApproach } = await import('#/engine/bot/BotNavigation.js');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function bot(x: number, z: number, level = 0) {
    const p = PlayerLoading.load(`env${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x; p.z = z; p.level = level; p.slot = serial; p.moveSpeed = 1;
    const b = new BotPlayer(p, new BotGoalPlanner());
    b.currentTask = { name: 'Environment', interrupted: false, reset() {}, interrupt() { this.interrupted = true; },
        shouldRun() { return true; }, isComplete() { return false; }, tick() {} } as any;
    return b;
}
function engineTick(p: any) {
    World.currentTick++;
    p.resetEntity(false);
    if (p.delayed && World.currentTick >= p.delayedUntil) p.delayed = false;
    if (!p.delayed && p.activeScript?.execution === ScriptState.SUSPENDED) p.executeScript(p.activeScript, true, true);
    p.processQueues(); p.processTimers(0); p.processTimers(1); p.processEngineQueue(); p.processInteraction();
}
const failures: string[] = [];
function check(name: string, run: () => void) {
    try { run(); console.log(`PASS ${name}`); } catch (e) { failures.push(name); console.error(`FAIL ${name}`, e); }
}
check('social road destinations avoid actual r254 bank plants and walls', () => {
    assert.equal(isMapBlocked(3253, 3415, 0), true); // confirmed original incident tile
    const b = bot(3253, 3412);
    const task = new SocialTask() as any;
    task.areaIndex = 1; task.coinsInitialized = true; task.cooldown = 0;
    task.handleScan(b.player);
    const spawn = (b as any).pendingTeleport;
    if (spawn) assert.equal(isMapBlocked(spawn.x, spawn.z, spawn.level) || BotCollisionMap.isCsvBlocked(spawn.level, spawn.x, spawn.z), false);
    task.areaInitialized = true;
    const originalRandom = Math.random;
    const targets: [number, number][] = [];
    b.navigation.request = (_x, _z, _l, x, z) => { targets.push([x, z]); return true; };
    try {
        Math.random = () => 0;
        for (let i = 0; i < 7; i++) { b.player.clearWaypoints(); task.handleScan(b.player); }
    } finally { Math.random = originalRandom; }
    assert.equal(targets.length, 7);
    for (const [x,z] of targets) {
        assert.equal(isMapBlocked(x,z,0) || BotCollisionMap.isCsvBlocked(0,x,z), false, `blocked social tile ${x},${z}`);
        assert.ok(botFindPath(0,3253,3412,x,z).length > 0 || (x === 3253 && z === 3412), `unreachable social tile ${x},${z}`);
    }
});
check('oak interaction tile uses actual dimensions and a reachable face', () => {
    const b = bot(3165, 3416);
    const oak = findLocByName(3161,3416,0,'oaktree',0)!;
    assert.ok(oak); assert.equal(oak.width, 3);
    const tile = (WoodcuttingTask.prototype as any)._approachTile(b.player, oak);
    assert.ok(tile);
    assert.equal(isMapBlocked(tile[0],tile[1],0) || BotCollisionMap.isCsvBlocked(0,...tile), false);
    assert.ok(botFindPath(0,b.player.x,b.player.z,...tile).length > 0 || (tile[0]===b.player.x && tile[1]===b.player.z));
    b.player.x=tile[0]; b.player.z=tile[1]; assert.equal(b.player.inOperableDistance(oak),true);
});
check('gate uses a native click, waits for opening, then permits collision-respecting travel', () => {
    const b = bot(3214,3261);
    const gate = findLocByName(3213,3261,0,'loc_1551',0)!;
    assert.ok(gate);
    // The old Manhattan adjacency check accepts this non-operable side.
    assert.equal(b.player.inOperableDistance(gate),false);
    assert.equal(isAdjacentToLoc(b.player,gate),false);
    let scripts=0; const execute=b.player.executeScript.bind(b.player);
    b.player.executeScript=(...args) => { scripts++; return execute(...args); };
    assert.equal(openNearbyGate(b.player,3),true);
    assert.equal(scripts,0,'helper must not directly execute gate scripts');
    assert.equal(b.player.target,gate);
    const route=Array.from(b.player.waypoints); const index=b.player.waypointIndex;
    walkTo(b.player,3211,3261);
    assert.equal(gate.isActive,true);
    assert.equal(b.player.waypointIndex,index); assert.deepEqual(Array.from(b.player.waypoints),route);
    for(let i=0;i<12;i++) { walkTo(b.player,3211,3261); engineTick(b.player); }
    assert.equal(gate.isActive,false,'closed gate must actually be replaced');
    for(let i=0;i<12;i++) { walkTo(b.player,3211,3261); engineTick(b.player); }
    assert.deepEqual([b.player.x,b.player.z,b.player.level],[3211,3261,0]);
});
check('locked door stays closed and is suppressed after a failed real interaction', () => {
    const b=bot(3273,3417);
    const door=findLocByName(3273,3417,0,'loc_1591',0)!; assert.ok(door);
    let scripts=0;const execute=b.player.executeScript.bind(b.player);
    b.player.executeScript=(...args) => { if(args[0].script.name.includes('oploc1,loc_1591') && !args[2]) scripts++; return execute(...args); };
    for(let i=0;i<80;i++) { openNearbyGate(b.player,1); engineTick(b.player); }
    assert.equal(door.isActive,true); assert.equal(door.type,1591);
    assert.equal(scripts,1,'known locked door should not be clicked again during cooldown');
    World.currentTick += 201;
    for(let i=0;i<80;i++) { openNearbyGate(b.player,1); engineTick(b.player); }
    assert.equal(scripts,2,'an expired suppression must permit a later legitimate retry');
    assert.equal((b as any).pendingTeleport,null);
});
check('native door crossing is verified from its reachable operating side after a detour', () => {
    const b=bot(3203,3174);
    b.player.run=0;
    const door=findLocByName(3202,3169,0,'zanarisdoor',0)!;
    assert.ok(door);
    const approach=findLocApproach(b.player,door)!;
    assert.ok(approach);
    assert.equal(approach.x,3201,'native approach goes around to the other side');
    let scriptTick=-1;
    const start=World.currentTick;
    const execute=b.player.executeScript.bind(b.player);
    b.player.executeScript=(...args)=>{
        if (!args[2] && args[0].script.name==='[oploc1,zanarisdoor]') scriptTick=World.currentTick-start;
        return execute(...args);
    };
    assert.equal(openNearbyGate(b.player,5),true);
    assert.equal(b.player.target,door);
    for(let i=0;i<24 && hasPendingObstacle(b.player);i++) {
        engineTick(b.player);
        pollObstacle(b.player);
    }
    assert.ok(scriptTick>0 && scriptTick<25,'the native interaction finishes within the existing deadline');
    assert.deepEqual([b.player.x,b.player.z],[3202,3169],'the native door script carries the player through');
    assert.equal(hasPendingObstacle(b.player),false,'successful passage must not wait for a false timeout');
    assert.equal(b.navigation.failures,0);
    assert.equal((b as any).pendingTeleport,null);
});
check('pending climb survives repeated walk requests until actual floor transition', () => {
    const b=bot(2443,3414);
    walkTo(b.player,2445,3416,1);
    const target=b.player.target; assert.ok(target); assert.equal(LocType.get(target.type).op?.[0],'Climb-up');
    let clicks=0; const set=b.player.setInteraction.bind(b.player); b.player.setInteraction=(...args)=>{clicks++;return set(...args);};
    walkTo(b.player,2446,3417,1);
    assert.equal(clicks,0,'pending climb was replaced');
    assert.equal(b.player.target,target,'walk request cancelled stairs');
    for(let i=0;i<12;i++) { engineTick(b.player); walkTo(b.player,2445,3416,1); }
    assert.deepEqual([b.player.x,b.player.z,b.player.level],[2445,3416,1]);
    walkTo(b.player,2443,3416,0);
    for(let i=0;i<15;i++) { engineTick(b.player); walkTo(b.player,2443,3416,0); }
    assert.equal(b.player.level,0);
});
check('r254 ladder scripts perform elevation changes through ordinary interactions', () => {
    const b=bot(3247,3409);
    const ladder=findLocByName(3247,3409,0,'loc_1747',0)!; assert.ok(ladder);
    assert.equal(b.player.inOperableDistance(ladder),true);
    interactLocOp(b.player,ladder,1);
    for(let i=0;i<8;i++) engineTick(b.player);
    assert.equal(b.player.level,1);
    assert.equal((b as any).pendingTeleport,null);
});
check('unsupported floor requests fail without walking indefinitely on the wrong floor', () => {
    const b=bot(3253,3412,1);
    walkTo(b.player,3253,3412,0);
    assert.equal(b.player.hasWaypoints(),false);
    assert.equal(b.navigation.failures,1);
    assert.equal((b as any).pendingTeleport,null);
});
check('agility recovers its Gnome course stage on the actual current floor', () => {
    const b=bot(2473,3421,1);
    const task=new AgilityTask({minLevel:1,location:[2474,3436,0],extra:{course:'GNOME'}} as any) as any;
    b.currentTask=task; task.state='obstacle'; task.obstacleIndex=0;
    task.tick(b.player);
    assert.equal(task.obstacleIndex,2,'floor-one recovery must resume with the branch, not the ground-floor log');
    assert.equal(b.player.level,1); assert.equal((b as any).pendingTeleport,null);
});
check('Gnome course completes a real lap through both platform floors', () => {
    const b=bot(2474,3436);
    const task=new AgilityTask({minLevel:1,location:[2474,3436,0],extra:{course:'GNOME'}} as any) as any;
    b.currentTask=task;
    const floors=new Set<number>(); const initial=b.player.stats[16];
    for(let i=0;i<500 && !task.interrupted && task.lapsCompleted<1;i++) {
        engineTick(b.player); b.tick(); floors.add(b.player.level);
    }
    assert.equal(task.lapsCompleted,1,`stage=${task.obstacleIndex} state=${task.state} position=${b.player.x},${b.player.z},${b.player.level}`);
    assert.deepEqual([...floors].sort(),[0,1,2]);
    assert.ok(b.player.stats[16]>initial,'XP must come from the course scripts');
    assert.equal((b as any).pendingTeleport,null);
});
check('navigation watchdog defers an inaccessible task without granting a teleport', () => {
    const b=bot(3253,3412);
    const watchdog=new ProgressWatchdog(3); watchdog.destination=[3253,3415,0];
    watchdog.check(b.player); watchdog.check(b.player); assert.equal(watchdog.check(b.player),true);
    assert.equal(b.currentTask!.interrupted,true);
    assert.equal((b as any).pendingTeleport,null); assert.equal(b.player.delayed,false);
    assert.deepEqual([b.player.x,b.player.z,b.player.level],[3253,3412,0]);
});
check('Al Kharid toll routing uses the existing northern opening without teleporting', () => {
    const b=bot(3267,3227);
    walkTo(b.player,3294,3172,0);
    assert.equal((b as any).pendingTeleport,null);
    assert.equal(b.player.delayed,false);
    assert.ok(b.player.hasWaypoints());
    for(let i=0;i<800 && (b.player.x!==3294 || b.player.z!==3172);i++) {
        engineTick(b.player); (b as any).ticksAlive++; walkTo(b.player,3294,3172,0);
    }
    assert.deepEqual([b.player.x,b.player.z,b.player.level],[3294,3172,0]);
    assert.equal((b as any).pendingTeleport,null);
});
if(failures.length) throw new Error(`Environmental regressions: ${failures.join('; ')}`);
console.log('environment runtime regression checks passed'); process.exit(0);
