// Opt-in Phase 1.2 measurements. Run in an assembled, packed r254 engine.
// Every invocation gets its own SQLite working directory and empty save profile.
import assert from 'node:assert/strict';
import type Npc from '#/engine/entity/Npc.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'world';
assert.ok(['world', 'edge', 'geared', 'decisions', 'travel', 'travel-fit', 'bank', 'agility'].includes(mode), 'Expected world, edge, geared, decisions, travel, travel-fit, bank or agility');
const engine = fileURLToPath(new URL('../../', import.meta.url));
assert.ok(fs.existsSync(path.join(engine, 'data/pack/server/script.dat')), 'Assemble and pack progressive-254 first');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r254-combat-'));
const originalCwd = process.cwd();

async function investigate() {
    fs.mkdirSync(path.join(temp, 'data'));
    for (const entry of ['src', 'node_modules', 'package.json', 'tsconfig.json', 'data/bot', 'data/config', 'data/pack', 'data/raw']) {
        fs.symlinkSync(path.join(engine, entry), path.join(temp, entry));
    }
    process.chdir(temp);
    Object.assign(process.env, {
        LOGIN_SERVER: 'false', FRIEND_SERVER: 'false', LOGGER_SERVER: 'false', NODE_MEMBERS: 'true',
        DB_BACKEND: 'sqlite', NODE_PROFILE: 'combat-probe', NODE_PRODUCTION: 'true', ENGINE_REVISION: '254',
        NODE_XPRATE: '1', NODE_PROGRESSIVE_XP: 'false', BOT_LOG_LEVEL: 'off', BOT_DEBUG_ENABLED: 'false',
        BUILD_SRC_DIR: path.resolve(engine, '../content'), BUILD_VERIFY: 'true', BUILD_VERIFY_FOLDER: 'true', BUILD_VERIFY_PACK: 'true'
    });
    let seed = 254;
    Math.random = () => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    const { default: World } = await import('#/engine/World.js');
    const { setWorld } = await import('#/engine/bot/BotWorld.js');
    const { BotCollisionMap } = await import('#/engine/bot/BotCollisionMap.js');
    const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
    const { BotGoalPlanner } = await import('#/engine/bot/BotGoalPlanner.js');
    const { BotManager } = await import('#/engine/bot/BotManager.js');
    const { BotLog } = await import('#/engine/bot/BotLog.js');
    const { SkillProgression, Items, Locations } = await import('#/engine/bot/BotKnowledge.js');
    const { PlayerStat } = await import('#/engine/entity/PlayerStat.js');
    const { CombatTask } = await import('#/engine/bot/tasks/CombatTask.js');
    const { AgilityTask } = await import('#/engine/bot/tasks/AgilityTask.js');
    const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
    const { default: Packet } = await import('#/io/Packet.js');
    const { default: NpcType } = await import('#/cache/config/NpcType.js');
    const { findPathToEntity, reachedEntity } = await import('#/engine/GameMap.js');
    const { validateBotPath } = await import('#/engine/bot/BotNavigation.js');
    const { CoordGrid } = await import('#/engine/CoordGrid.js');
    const { findLootObj } = await import('#/engine/bot/BotAction.js');
    const { default: ScriptState } = await import('#/engine/script/ScriptState.js');
    const { default: InvType } = await import('#/cache/config/InvType.js');

    await World.start(false, false);
    setWorld(World);
    BotCollisionMap.init('data/bot/unwalkable_tiles.csv');
    // In-game activity timers see one 600 ms tick, independent of host speed.
    const epoch = Date.now();
    Date.now = () => epoch + World.currentTick * 600;
    const p = PlayerLoading.load('phaseprobe', new Packet(new Uint8Array()), null);
    const b = new BotPlayer(p, new BotGoalPlanner());
    const chickenStep = SkillProgression.ATTACK[0];
    const edgeStep = SkillProgression.ATTACK.find(step => step.extra?.npcType === 'man')!;
    const guardStep = SkillProgression.ATTACK.find(step => step.extra?.npcType === 'guard')!;
    const combatStep = mode === 'geared' ? guardStep : mode === 'world' ? chickenStep : edgeStep;
    const task = new CombatTask(combatStep, PlayerStat.ATTACK);
    b.currentTask = task;
    const info = () => task.getDebugInfo(p);
    function report(name: string, values: object) {
        console.log(name, JSON.stringify(values));
    }
    let gateDuringFight = 0;
    const event = BotLog.event.bind(BotLog);
    BotLog.event = (...args) => {
        if (args[1] === p.username && ['gate_attempt', 'obstacle_failed', 'gate_opened', 'gate_block_npc', 'task_deferred',
            'target_unreachable', 'no_attack_timeout', 'navigation_oscillation', 'navigation_stuck'].includes(args[2])) {
            const target = (task as unknown as {currentNpc: Npc | null}).currentNpc;
            if (args[2] === 'gate_attempt' && target?.isActive && p.inOperableDistance(target)) gateDuringFight++;
            report(args[2], { tick: World.currentTick, at: [p.x, p.z], message: args[3], target: info().target,
                nid: target?.nid, active: target?.isActive, operable: target && p.inOperableDistance(target) });
        }
        event(...args);
    };
    function playerTick() {
        // Same native player phases as the existing environment/journey fixtures.
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
    }

    if (mode === 'decisions') {
        // Read the spawn map before NPC wandering. The extra fields are observation
        // points for this baseline. No NPC or collision flag is moved or replaced.
        const probe = task as unknown as {
            state: string;
            _findTargetNpc(player: typeof p): Npc | null;
            _isNpcAvailable(npc: Npc): boolean;
        };
        p.x = 3101; p.z = 3511; p.level = 0; p.slot = 1;
        const selected = probe._findTargetNpc(p);
        const other = [...World.npcs].find(n => n?.isActive && n.x === 3101 && n.z === 3509 && n.level === 0 && NpcType.get(n.type).debugname === 'man3');
        assert.ok(selected && other);
        assert.equal(selected, other);
        const blocked = [...World.npcs].find(npc => npc?.isActive && npc.level === 0 && npc.x === 3100 && npc.z === 3511 &&
            NpcType.get(npc.type).debugname === 'man2');
        assert.ok(blocked);
        for (const npc of [blocked, selected]) {
            const route = findPathToEntity(0, p.x, p.z, npc.x, npc.z, p.width, npc.width, npc.length);
            const end = route.length ? CoordGrid.unpackCoord(route[route.length - 1]) : p;
            const reachable = reachedEntity(0, end.x, end.z, npc.x, npc.z, npc.width, npc.length, p.width);
            assert.equal(reachable, npc === selected);
            report('candidate', { selected: npc === selected, name: NpcType.get(npc.type).debugname, nid: npc.nid,
                at: [npc.x, npc.z], available: probe._isNpcAvailable(npc), operableHere: p.inOperableDistance(npc),
                endpoint: [end.x, end.z], operableAtEnd: reachable,
                routeCheck: validateBotPath(0, p.x, p.z, route) });
        }
        p.applyDamage(8, 1);
        task.tick(p);
        assert.equal(info().state, 'flee');
        assert.equal(info().details?.hp, 2);
        report('damaged', { currentHP: p.levels[3], baseHP: p.baseLevels[3], hitpointsXpInternal: p.stats[3], decision: info() });
        // A separate fresh character at the same site enters the actual empty-loot
        // state that follows losing a target. Drive the task through its normal owner.
        const fresh = PlayerLoading.load('emptyloot', new Packet(new Uint8Array()), null);
        fresh.x = p.x; fresh.z = p.z; fresh.level = 0; fresh.slot = 2;
        const owner = new BotPlayer(fresh, new BotGoalPlanner());
        const empty = new CombatTask(edgeStep, PlayerStat.ATTACK);
        owner.currentTask = empty;
        assert.equal(findLootObj(fresh, fresh.x, fresh.z, 0, 5), null);
        (empty as unknown as {state: string}).state = 'loot';
        const before = BotLog.counts.no_attack_timeout ?? 0;
        let ticks = 0;
        let scans = 0;
        while (ticks < 4 && !empty.interrupted && owner.currentTask === empty) {
            World.currentTick++; fresh.playtime++; ticks++;
            owner.tick();
            if (empty.getDebugInfo(fresh).state === 'scan') scans++;
        }
        assert.ok(scans > 0);
        assert.equal((BotLog.counts.no_attack_timeout ?? 0) - before, 0);
        assert.equal(empty.interrupted, false);
        report('emptyLoot', { ticks, scans, timeouts: (BotLog.counts.no_attack_timeout ?? 0) - before,
            interrupted: empty.interrupted, plannerDeferred: owner.planner.isDeferred('Combat', fresh.playtime) });
        // A fixture with a qualifying owned weapon and no armour or food.
        const trainee = PlayerLoading.load('guardprobe', new Packet(new Uint8Array()), null);
        [trainee.x, trainee.z, trainee.level] = guardStep.location;
        trainee.setLevel(PlayerStat.ATTACK, guardStep.minLevel);
        trainee.getInventory(InvType.INV)!.add(guardStep.toolItemIds[0], 1);
        const guards = new CombatTask(guardStep, PlayerStat.ATTACK);
        const guard = (guards as unknown as typeof probe)._findTargetNpc(trainee);
        assert.equal(guard, null);
        report('risk', { at: guardStep.location, playerLevel: trainee.getCombatLevel(), hp: trainee.levels[3],
            requiredWeapon: guardStep.toolItemIds[0], canRun: guards.shouldRun(trainee),
            rejectedGuard: guard === null });
        return;
    }

    if (mode === 'travel' || mode === 'travel-fit' || mode === 'agility') {
        p.level = 0; p.slot = 1; p.moveSpeed = 1;
        // Advance the planner past its one-time Init selection; no items are granted.
        b.planner.pickTask(p);
        if (mode === 'agility') {
            p.x = 2474; p.z = 3436;
            const course = new AgilityTask(SkillProgression.AGILITY[0]);
            b.currentTask = course;
            const laps = () => (course as unknown as {lapsCompleted: number}).lapsCompleted;
            let peak = 0;
            const start = p.stats[PlayerStat.AGILITY];
            for (let i = 0; i < 1400 && b.currentTask === course && !course.interrupted && !course.isComplete(p); i++) {
                playerTick();
                if (laps() > peak) {
                    peak = laps();
                    report('lap', { tick: World.currentTick, lap: peak, xpInternal: p.stats[PlayerStat.AGILITY] - start });
                }
            }
            report('courseExit', { tick: World.currentTick, peak, laps: laps(), complete: course.isComplete(p), next: b.currentTask?.name });
        } else {
            p.x = 2725; p.z = 3485;
            // Same in-memory character and destination. Model a hardy traveller
            // with an eligible low Attack tier, keeping inventory and fares empty.
            if (mode === 'travel-fit') {
                p.setLevel(PlayerStat.HITPOINTS, 70);
                p.setLevel(PlayerStat.DEFENCE, 70);
            }
            const origin = [p.x, p.z];
            let lastMove = 0;
            let moved = 0;
            for (let i = 0; i < 330 && !task.interrupted && b.currentTask === task; i++) {
                const [x, z] = [p.x, p.z];
                playerTick();
                if (x !== p.x || z !== p.z) { moved++; lastMove = World.currentTick; }
            }
            if (mode === 'travel-fit') {
                assert.ok(World.currentTick > 300 && moved > 290);
                assert.equal(task.interrupted, false);
            }
            report('journeyEnd', { tick: World.currentTick, origin, dest: edgeStep.location, at: [p.x, p.z],
                movedTicks: moved, lastMove, interrupted: task.interrupted, travelSerial: b.navigation.meaningfulTravelSerial });
        }
        return;
    }

    // One player takes the normal login and world-cycle path. Existing native
    // NPCs wander, retaliate, die, respawn and drop items. Observe XP at its source.
    [p.x, p.z] = mode === 'edge' ? [3101, 3511] : [3237, 3295];
    p.level = 0; p.is_bot = true;
    if (mode === 'geared') {
        [p.x, p.z, p.level] = guardStep.location;
        p.setLevel(PlayerStat.ATTACK, guardStep.minLevel);
        p.getInventory(InvType.INV)!.add(guardStep.toolItemIds[0], 1);
        b.planner.pickTask(p);
    }
    task.reset();
    const { bankInvId } = await import('#/engine/bot/tasks/BotTaskBase.js');
    if (mode === 'bank') {
        [p.x, p.z, p.level] = Locations.DRAYNOR_BANK;
        (task as unknown as {state: string}).state = 'bank_walk';
        p.getInventory(InvType.INV)!.add(Items.COINS, 271);
        p.getInventory(InvType.INV)!.add(Items.BONES, 1);
        p.getInventory(bankInvId())!.add(Items.SHRIMP, 6);
    }
    const { totalCostOfMissing, getMissingPurchases } = await import('#/engine/bot/BotNeeds.js');
    let gearedTicks = 0;
    let ateShrimp = false;
    let kills = 0;
    let attacksAfterKill = 0;
    const trained = new Set<number>();
    const xp = { nativeMelee: 0, taskMelee: 0, nativeHitpoints: 0 };
    let scriptDepth = 0;
    const engaged = new Map<Npc, boolean>();
    const drops = new Map<number, number>();
    const execute = p.executeScript.bind(p);
    p.executeScript = (...args) => {
        const state = args[0];
        const npc = state._activeNpc;
        if (!args[2] && npc && state.script.name.startsWith('[opnpc2,') && !engaged.has(npc)) {
            if (kills) attacksAfterKill++;
            engaged.set(npc, true);
            report('nativeAttack', { tick: World.currentTick, nid: npc.nid, at: [p.x, p.z], operable: p.inOperableDistance(npc) });
        }
        if (!args[2] && state.script.name.startsWith('[opobj3,') && state._activeObj) {
            const item = state._activeObj.type;
            drops.set(item, p.getInventory(InvType.INV)!.getItemCount(item));
            report('pickupScript', { tick: World.currentTick, item });
        }
        scriptDepth++;
        try { return execute(...args); } finally { scriptDepth--; }
    };
    const addXp = p.addXp.bind(p);
    p.addXp = (...args) => {
        const stat = args[0];
        const before = p.stats[stat];
        addXp(...args);
        const delta = p.stats[stat] - before;
        if (stat <= PlayerStat.STRENGTH && delta) {
            if (scriptDepth) trained.add(stat);
            xp[scriptDepth ? 'nativeMelee' : 'taskMelee'] += delta;
            report('meleeXp', { tick: World.currentTick, native: !!scriptDepth, stat, internal: delta, target: info().target });
        }
        if (scriptDepth && stat === PlayerStat.HITPOINTS) xp.nativeHitpoints += delta;
    };
    BotManager.tick = () => {
        if (!p.isActive || task.interrupted || b.currentTask !== task) return;
        if (mode === 'geared' && p.playtime === 6) {
            p.applyDamage(8, 1);
            p.getInventory(InvType.INV)!.add(Items.SHRIMP, 1);
        }
        b.tick();
        if (mode === 'geared' && p.playtime >= 6 && p.levels[PlayerStat.HITPOINTS] === 5 &&
            !p.getInventory(InvType.INV)!.contains(Items.SHRIMP)) ateShrimp = true;
        if (mode === 'geared' && p.playtime <= 5) {
            const weapon = guardStep.toolItemIds[0];
            gearedTicks++;
            assert.equal(p.getInventory(InvType.WORN)!.getItemCount(weapon), 1);
            assert.equal(task.shouldRun(p), true);
            assert.equal(totalCostOfMissing(p, guardStep), 0);
            assert.deepEqual(getMissingPurchases(p, guardStep), []);
            report('gear', { tick: World.currentTick, backpack: p.getInventory(InvType.INV)!.getItemCount(weapon),
                worn: p.getInventory(InvType.WORN)!.getItemCount(weapon), canRun: task.shouldRun(p), activeTask: b.currentTask?.name });
        }
    };
    const cycle = World.cycle.bind(World);
    // World.cycle schedules its successor. Drive precisely one native cycle per iteration.
    World.cycle = () => {};
    World.tickRate = 0;
    for (let i = 0; i < (mode === 'bank' ? 40 : 200) && !task.interrupted && b.currentTask === task; i++) {
        if (i === 20) World.newPlayers.add(p);
        const before = World.currentTick;
        cycle();
        // A native ground pickup can suspend and resume under a different script label.
        for (const [item, count] of drops) {
            const now = p.getInventory(InvType.INV)!.getItemCount(item);
            if (now > count) report('received', { tick: before, item, quantity: now - count });
            drops.set(item, now);
        }
        for (const [npc, wasActive] of engaged) {
            if (wasActive && !npc.isActive) {
                if (npc.levels[3] === 0 && npc.heroPoints.findHero() === p.hash64) kills++;
                report('despawn', { tick: before, nid: npc.nid, at: [npc.x, npc.z] });
            }
            engaged.set(npc, npc.isActive);
        }
        assert.equal(World.currentTick, before + 1);
    }
    if (mode === 'world') {
        assert.ok(xp.nativeMelee > 0);
        assert.equal(xp.taskMelee, 0);
        assert.ok(engaged.size >= 2);
        assert.ok(p.getInventory(InvType.INV)!.getItemCount(2138) > 0);
        assert.equal(gateDuringFight, 0);
        assert.ok(kills >= 2 && attacksAfterKill >= 1);
        assert.equal(trained.size, 3);
    }
    if (mode === 'geared') {
        assert.ok(gearedTicks >= 2);
        assert.ok(ateShrimp, 'the native food script healed the injured character');
    }
    if (mode === 'bank') {
        const bank = p.getInventory(bankInvId())!;
        assert.equal(bank.getItemCount(Items.COINS), 71);
        assert.equal(bank.getItemCount(Items.BONES), 1);
        assert.equal(p.getInventory(InvType.INV)!.getItemCount(Items.SHRIMP), 6);
    }
    report('worldEnd', { tick: World.currentTick, xpInternal: xp, state: info(), events: BotLog.counts });
}
let status = 0;
try { await investigate(); } catch (error) { console.error(error); status = 1; }
finally { process.chdir(originalCwd); fs.rmSync(temp, {recursive: true, force: true}); }
process.exit(status);
