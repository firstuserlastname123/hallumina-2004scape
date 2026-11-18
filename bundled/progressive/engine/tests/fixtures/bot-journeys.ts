import assert from 'node:assert/strict';
const { default: World } = await import('#/engine/World.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: VarPlayerType } = await import('#/cache/config/VarPlayerType.js');
const { default: Environment } = await import('#/util/Environment.js');
const { default: ScriptState } = await import('#/engine/script/ScriptState.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { BotGoalPlanner, Personalities } = await import('#/engine/bot/BotGoalPlanner.js');
const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
const { setWorld } = await import('#/engine/bot/BotWorld.js');
const { walkTo } = await import('#/engine/bot/BotAction.js');
const { ProgressWatchdog } = await import('#/engine/bot/tasks/BotTaskBase.js');
const { chooseTravel, carriedCoins, tunnelAvailable, travelCondition, onKaramja } = await import('#/engine/bot/BotTravel.js');
await World.start(false, false);
setWorld(World);
BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
let serial = 0;
function make(x: number, z: number, coins = 0, strong = false) {
    const p = PlayerLoading.load(`journey${++serial}`, new Packet(new Uint8Array()), null);
    p.x = x;
    p.z = z;
    p.level = 0;
    p.slot = serial;
    p.moveSpeed = 1;
    if (strong) {
        for (const stat of [0, 1, 2, 3]) {
            p.baseLevels[stat] = 70;
            p.levels[stat] = 70;
        }
    }
    const b = new BotPlayer(p, new BotGoalPlanner(Personalities.BALANCED));
    if (coins) p.getInventory(InvType.INV)!.add(995, coins);
    const watchdog = new ProgressWatchdog();
    b.currentTask = {
        name: 'Journey',
        interrupted: false,
        reset() {},
        interrupt() {
            this.interrupted = true;
        },
        shouldRun() {
            return true;
        },
        isComplete() {
            return false;
        },
        tick() {}
    } as any;
    (b.planner as any).pickTask = () => null;
    return { b, p, watchdog };
}
function step(b: any) {
    const p = b.player;
    World.currentTick++;
    p.playtime++;
    p.resetEntity(false);
    if (p.delayed && World.currentTick >= p.delayedUntil) p.delayed = false;
    if (!p.delayed && p.activeScript?.execution === ScriptState.SUSPENDED) p.executeScript(p.activeScript, true, true);
    p.processQueues();
    p.processTimers(0);
    p.processTimers(1);
    p.processEngineQueue();
    p.processInteraction();
    b.tick();
    (World as any).processZones();
}
function travel(test: ReturnType<typeof make>, x: number, z: number, limit = 2500) {
    const { p, b, watchdog } = test;
    b.currentTask!.tick = () => {
        if (!watchdog.check(p)) walkTo(p, x, z, 0);
    };
    let ticks = 0;
    for (; ticks < limit && !b.currentTask!.interrupted; ticks++) {
        step(b);
        if (p.level === 0 && Math.max(Math.abs(p.x - x), Math.abs(p.z - z)) <= 2 && !p.activeScript && !p.delayed) break;
    }
    console.log('ROUTE', p.username, 'to', x, z, 'at', p.x, p.z, p.level, 'ticks', ticks, 'coins', carriedCoins(p), 'fail', b.navigation.failures);
    assert.ok(!b.currentTask!.interrupted, `deferred en route to ${x},${z}`);
    assert.ok(ticks < limit, `arrival not observed at ${x},${z}`);
    return ticks;
}
const failures: string[] = [];
function check(name: string, fn: () => void) {
    try {
        fn();
        console.log('PASS', name);
    } catch (e) {
        failures.push(name);
        console.error('FAIL', name, e);
    }
}
check('native Sarim and customs return deduct exactly 30 each, including retries', () => {
    const t = make(3028, 3218, 60);
    travel(t, 2954, 3147, 400);
    assert.equal(carriedCoins(t.p), 30);
    travel(t, 3028, 3217, 400);
    assert.equal(carriedCoins(t.p), 0);
});
check('native Ardougne and Brimhaven customs return deduct exactly 30 each', () => {
    const t = make(2679, 3274, 60);
    travel(t, 2772, 3230, 400);
    assert.equal(carriedCoins(t.p), 30);
    travel(t, 2679, 3275, 400);
    assert.equal(carriedCoins(t.p), 0);
});
check('Dragon Slayer menu variation selects the real Karamja fare option', () => {
    const t = make(3028, 3218, 60);
    t.p.vars[VarPlayerType.getId('dragonquest')] = 2;
    travel(t, 2954, 3147, 400);
    assert.equal(carriedCoins(t.p), 30);
    assert.equal(t.p.vars[VarPlayerType.getId('dragonquest')], 2);
});
check('interrupted paid voyage cannot charge a second fare on retry', () => {
    const t = make(3028, 3218, 90);
    t.b.currentTask!.tick = () => walkTo(t.p, 2954, 3147);
    for (let i = 0; i < 60 && carriedCoins(t.p) === 90; i++) step(t.b);
    assert.equal(carriedCoins(t.p), 60);
    World.currentTick += 121;
    t.p.delayed = false;
    t.b.tick();
    assert.equal(t.b.currentTask!.interrupted, true);
    // Simulate a server-side script interruption after payment, before arrival.
    t.p.activeScript = null;
    t.p.protect = false;
    t.p.closeModal();
    t.p.clearPendingAction();
    const next = {
        name: 'Retry',
        interrupted: false,
        reset() {},
        interrupt() {
            this.interrupted = true;
        },
        shouldRun() {
            return true;
        },
        isComplete() {
            return false;
        },
        tick() {}
    };
    t.b.currentTask = next as any;
    walkTo(t.p, 2954, 3147);
    assert.equal(carriedCoins(t.p), 60);
    assert.equal(next.interrupted, true);
    assert.equal(t.p.hasInteraction(), false);
});
check('food, armour, personality and energy change the continuous travel assessment', () => {
    const t = make(2965, 3380, 120);
    const before = travelCondition(t.p);
    t.p.getInventory(InvType.INV)!.add(379, 10);
    t.p.getInventory(InvType.WORN)!.add(1127, 1);
    assert.ok(travelCondition(t.p).food > before.food);
    assert.ok(travelCondition(t.p).armour > before.armour);
    const fighter = new BotPlayer(t.p, new BotGoalPlanner(Personalities.FIGHTER));
    assert.ok(travelCondition(t.p).appetite > before.appetite);
    t.p.runenergy = 0;
    assert.ok(travelCondition(t.p).speed < before.speed);
    void fighter;
});
check('membership and customs restrictions reject a route without charging', () => {
    const t = make(2954, 3147, 30);
    t.p.getInventory(InvType.INV)!.add(431, 1);
    walkTo(t.p, 3028, 3217);
    assert.equal(t.b.currentTask!.interrupted, true);
    assert.equal(carriedCoins(t.p), 30);
    const member = make(3218, 3218, 120);
    const previous = Environment.NODE_MEMBERS;
    try {
        Environment.NODE_MEMBERS = false;
        assert.equal(chooseTravel(member.p, 2474, 3436).mode, 'restricted');
    } finally {
        Environment.NODE_MEMBERS = previous;
    }
});
check('Rimmington and Port Sarim remain mainland while Musa Point and Brimhaven are islands', () => {
    assert.equal(onKaramja(2950, 3200), false);
    assert.equal(onKaramja(3028, 3217), false);
    assert.equal(onKaramja(2954, 3147), true);
    assert.equal(onKaramja(2772, 3230), true);
});
check('a blocked disembark after payment still times out without a second fare', () => {
    const t = make(3028, 3218, 90);
    t.b.currentTask!.tick = () => walkTo(t.p, 2954, 3147);
    for (let i = 0; i < 60 && carriedCoins(t.p) === 90; i++) step(t.b);
    assert.equal(carriedCoins(t.p), 60);
    const has = t.p.hasInteraction.bind(t.p);
    t.p.hasInteraction = () => true;
    try {
        for (let i = 0; i < 160 && !t.b.currentTask!.interrupted; i++) step(t.b);
    } finally {
        t.p.hasInteraction = has;
    }
    assert.equal(t.b.currentTask!.interrupted, true);
    assert.equal(carriedCoins(t.p), 60);
});
check('unaffordable island travel defers without payment', () => {
    const t = make(3028, 3218, 29);
    walkTo(t.p, 2954, 3147);
    assert.equal(t.b.currentTask!.interrupted, true);
    assert.equal(carriedCoins(t.p), 29);
    assert.equal(t.p.hasInteraction(), false);
});
check('risk, health, food, cash and personality influence a full-journey choice', () => {
    const low = make(3218, 3218, 120);
    assert.equal(chooseTravel(low.p, 2474, 3436).mode, 'ship');
    assert.equal(chooseTravel(low.p, 2474, 3436).reserve, 120);
    low.p.getInventory(InvType.INV)!.remove(995, 1);
    assert.equal(chooseTravel(low.p, 2474, 3436).mode, 'unaffordable');
    const fighter = make(2965, 3380, 0, true);
    assert.equal(chooseTravel(fighter.p, 2808, 3440).mode, 'land');
    fighter.p.levels[3] = 1;
    assert.equal(chooseTravel(fighter.p, 2808, 3440).mode, 'unaffordable');
});
check('quest restricted tunnel is rejected without changing quest state', () => {
    const t = make(2877, 3482, 120);
    assert.equal(tunnelAvailable(t.p), false);
    const id = VarPlayerType.getId('fishingcompo');
    assert.equal(t.p.vars[id], 0);
    assert.notEqual(chooseTravel(t.p, 2808, 3440).mode, 'tunnel');
});
check('completed Fishing Contest uses native stairs and traverses the actual tunnel', () => {
    const t = make(2877, 3482);
    t.p.vars[VarPlayerType.getId('fishingcompo')] = 5;
    assert.equal(chooseTravel(t.p, 2808, 3440).mode, 'tunnel');
    travel(t, 2808, 3440, 600);
    assert.equal(t.p.vars[VarPlayerType.getId('fishingcompo')], 5);
    assert.equal(carriedCoins(t.p), 0);
});
check('strong character walks Falador to Catherby past the old watchdog deadline', () => {
    const t = make(2965, 3380, 0, true);
    assert.ok(travel(t, 2808, 3440) > 300);
});
check('realistic Varrock to Gnome course land journey retains bounded travel progress', () => {
    const t = make(3210, 3425, 0, true);
    travel(t, 2474, 3436, 2500);
});
check('low-level full journey retains return fares and returns using native boats', () => {
    const t = make(3218, 3218, 120);
    travel(t, 2474, 3436, 2500);
    assert.equal(carriedCoins(t.p), 60);
    travel(t, 3218, 3218, 2500);
    assert.equal(carriedCoins(t.p), 0);
});
check('an actually blocked r254 bank tile still exhausts bounded recovery', () => {
    const t = make(3253, 3412, 0, true);
    t.b.currentTask!.tick = () => {
        if (!t.watchdog.check(t.p)) walkTo(t.p, 3253, 3415);
    };
    for (let i = 0; i < 600 && !t.b.currentTask!.interrupted; i++) step(t.b);
    assert.equal(t.b.currentTask!.interrupted, true);
    assert.notDeepEqual([t.p.x, t.p.z], [3253, 3415]);
    assert.equal((t.b as any).pendingTeleport, null);
});
check('unmoving watchdog still defers at 300 active ticks', () => {
    const t = make(3253, 3412);
    for (let i = 0; i < 299; i++) assert.equal(t.watchdog.check(t.p), false);
    assert.equal(t.watchdog.check(t.p), true);
    assert.equal(t.b.currentTask!.interrupted, true);
    assert.deepEqual([t.p.x, t.p.z], [3253, 3412]);
});
if (failures.length) throw Error(failures.join('; '));
console.log('journey runtime regression checks passed');
process.exit(0);
