/** Run only in a disposable assembled runtime. See docs/playerbot-reliability.md. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ticks = Number(process.env.BOT_SIM_TICKS ?? 6000);
const interval = Number(process.env.BOT_SIM_INTERVAL_MS ?? 0);
const seed = Number(process.env.BOT_SIM_SEED ?? 254);
const output = process.env.BOT_SIM_OUTPUT;
if (!output || !Number.isInteger(ticks) || ticks < 20 || !Number.isFinite(interval) || interval < 0 || !Number.isSafeInteger(seed)) {
    throw new Error('Set BOT_SIM_OUTPUT, BOT_SIM_TICKS (>=20), and optionally BOT_SIM_INTERVAL_MS / BOT_SIM_SEED.');
}
if (process.env.NODE_PROFILE !== 'bot-simulation' || process.env.DB_BACKEND !== 'sqlite') {
    throw new Error('Use NODE_PROFILE=bot-simulation DB_BACKEND=sqlite in a disposable runtime.');
}
if (fs.existsSync('data/players/bot-simulation')) throw new Error('Simulation saves already exist; use a fresh runtime.');
if (!fs.existsSync('.bot-simulation-runtime')) throw new Error('Create .bot-simulation-runtime only in a disposable assembled runtime.');
const safetyDb = new DatabaseSync('db.sqlite', { readOnly: true });
const humans = safetyDb.prepare("SELECT COUNT(*) AS count FROM account WHERE password != '!bot'").get()!;
safetyDb.close();
if (Number(humans.count) !== 0) throw new Error('Refusing a database containing human accounts; initialize a fresh SQLite database.');

// Seed before importing the engine (personalities, NPCs and actions use Math.random).
let rng = seed >>> 0;
Math.random = () => {
    rng = (Math.imul(1664525, rng) + 1013904223) >>> 0;
    return rng / 0x100000000;
};
const { default: World } = await import('#/engine/World.js');
const { BotManager } = await import('#/engine/bot/BotManager.js');
const { BotRouteRetry } = await import('#/engine/bot/BotRouteRetry.js');
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { db } = await import('#/db/query.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: Environment } = await import('#/util/Environment.js');
const { default: Player } = await import('#/engine/entity/Player.js');
const { default: Loc } = await import('#/engine/entity/Loc.js');
const { default: LocType } = await import('#/cache/config/LocType.js');
const { canTravel } = await import('#/engine/GameMap.js');
const { CollisionType } = await import('@2004scape/rsmod-pathfinder');
const logModule = fs.existsSync('src/engine/bot/BotLog.ts') ? await import('#/engine/bot/BotLog.js') : null;
const { default: Packet } = await import('#/io/Packet.js');
if (Environment.ENGINE_REVISION !== 254) throw new Error('This simulation requires revision 254.');

// Compare identical encounter observations on both revisions. Count the first
// native melee XP for each player/NPC life, and credit deaths to the native hero.
const melee = { damagingEngagements: 0, kills: 0, nativeXp: 0, taskXp: 0, emptySearches: 0,
    travelProgress: 0, deferrals: 0, unreachable: 0, noAttack: 0 };
const fighters = new Map<import('#/engine/entity/Npc.js').default, Set<bigint>>();
const removeNpc = World.removeNpc.bind(World);
World.removeNpc = (npc, duration) => {
    if (npc.levels[3] === 0 && fighters.get(npc)?.has(npc.heroPoints.findHero())) melee.kills++;
    fighters.delete(npc);
    return removeNpc(npc, duration);
};
const { CombatTask } = await import('#/engine/bot/tasks/CombatTask.js');
const combatPrototype = CombatTask.prototype as any;
const search = combatPrototype._findTargetNpc;
combatPrototype._findTargetNpc = function (p: InstanceType<typeof Player>) {
    const result = search.call(this, p);
    if (!result) melee.emptySearches++;
    return result;
};
let scriptNpc: import('#/engine/entity/Npc.js').default | undefined;
const navigationFailures: Record<string, number> = {};
const failureSamples: object[] = [];
const services = { bankOpened: 0, shopOpened: 0 };
const modals = new WeakMap<object, number>();
const counters = { oscillation: 0, stationaryOscillation: 0, stuck: 0, timeoutMessages: 0, timeoutDiagnostics: 0, missingSheepMessages: 0, logLines: 0, logBytes: 0, errors: 0, blockedStepsQueued: 0, noOpPathsQueued: 0,
    routesQueued: 0, activeRoutesCleared: 0, pathFailures: 0, noProgress: 0, taskDeferrals: 0, subtaskDeferrals: 0, subtasksScheduled: 0 };
// Same observers are copied to both implementations. Script starts include the
// baseline's direct gate execution as well as normal engine-dispatched scripts.
let nativeScriptDepth = 0;
const participation = { idleBotTicks: 0, travelBotTicks: 0, supportBotTicks: 0, activityBotTicks: 0,
    progressionActivityBotTicks: 0, agilityTaskBotTicks: 0, nativeXpBotTicks: 0, requestedTileArrivals: 0, faresPaid: 0 };
const transportLegs: Record<string, { started: number; arrived: number; coins: number }> = {};
const nativeXp = new Map<string, number>();
const xpThisTick = new Set<string>();
const targets = new WeakMap<object, {x:number;z:number;level:number;distance:number}>();
function observeArrival(retry: object, x:number,z:number,level:number) {
    const previous=targets.get(retry);
    if(previous && previous.distance>0 && previous.x===x && previous.z===z && previous.level===level) {
        participation.requestedTileArrivals++; previous.distance=0;
    }
}
const retryRequest=BotRouteRetry.prototype.request;
BotRouteRetry.prototype.request=function(...args) {
    observeArrival(this,args[0],args[1],args[2]);
    targets.set(this,{x:args[3],z:args[4],level:args[5],distance:args[2]===args[5]?Math.max(Math.abs(args[0]-args[3]),Math.abs(args[1]-args[4])):Infinity});
    return retryRequest.apply(this,args);
};
const retryObserve=BotRouteRetry.prototype.observe;
BotRouteRetry.prototype.observe=function(...args){observeArrival(this,args[0],args[1],args[2]);return retryObserve.apply(this,args);};
const retryReset=BotRouteRetry.prototype.reset;
BotRouteRetry.prototype.reset=function(){targets.delete(this);return retryReset.call(this);};
const obstacles = { gateClicks: 0, gateScripts: 0, gateOpened: 0, gateUnverified: 0,
    transitionClicks: 0, transitionScripts: 0, transitionCompleted: 0, transitionUnverified: 0 };
const completions: Record<string, number> = {};
const pendingObstacles: { player: InstanceType<typeof Player>; loc: InstanceType<typeof Loc>; type: number;
    angle: number; shape: number; level: number; x: number; z: number; tick: number; gate: boolean }[] = [];
function obstacleKind(loc: InstanceType<typeof Loc>): 'gate' | 'transition' | null {
    const t = LocType.get(loc.type);
    const ops = (t.op ?? []).filter((op): op is string => typeof op === 'string');
    if (/door|gate|curtain/i.test(t.name ?? '') && ops.some(op => /^(open|walk-through|pass-through|pay)/i.test(op))) return 'gate';
    if (ops.some(op => /^(climb|walk-on|balance|squeeze|swing|cross|jump)/i.test(op))) return 'transition';
    return null;
}
function edgeOpen(o: typeof pendingObstacles[number]): boolean {
    const dx = [-1, 0, 1, 0][o.angle];
    const dz = [0, 1, 0, -1][o.angle];
    return canTravel(o.level, o.loc.x, o.loc.z, dx, dz, 1, 0, CollisionType.NORMAL);
}
function observeObstacles(final = false): void {
    for (let i = pendingObstacles.length - 1; i >= 0; i--) {
        const o = pendingObstacles[i];
        const changed = !o.loc.isValid() || o.loc.type !== o.type || o.loc.angle !== o.angle || o.loc.shape !== o.shape;
        const settled = !o.player.delayed && !o.player.activeScript && !o.player.hasInteraction();
        const completed = o.gate ? changed && edgeOpen(o) : settled && (
            o.player.level !== o.level || Math.max(Math.abs(o.player.x - o.x), Math.abs(o.player.z - o.z)) >= 2);
        if (completed || (!o.gate && settled) || World.currentTick - o.tick >= 25 || final) {
            if (o.gate) { if (completed) obstacles.gateOpened++; else obstacles.gateUnverified++; }
            else { if (completed) obstacles.transitionCompleted++; else obstacles.transitionUnverified++; }
            pendingObstacles.splice(i, 1);
        }
    }
}
const setInteraction = Player.prototype.setInteraction;
Player.prototype.setInteraction = function (...args) {
    const result = setInteraction.apply(this, args);
    if (result && this.is_bot && args[1] instanceof Loc) {
        const kind = obstacleKind(args[1]);
        if (kind === 'gate') obstacles.gateClicks++;
        if (kind === 'transition') obstacles.transitionClicks++;
    }
    return result;
};
const executeScript = Player.prototype.executeScript;
Player.prototype.executeScript = function (...args) {
    const state = args[0];
    const loc = state._activeLoc;
    if (this.is_bot && !args[2] && loc && /oploc[1-5],/.test(state.script.name)) {
        const kind = obstacleKind(loc);
        if (kind) {
            if (kind === 'gate') obstacles.gateScripts++; else obstacles.transitionScripts++;
            pendingObstacles.push({ player: this, loc, type: loc.type, angle: loc.angle, shape: loc.shape,
                level: this.level, x: this.x, z: this.z, tick: World.currentTick, gate: kind === 'gate' });
        }
    }
    const previousNpc = scriptNpc;
    scriptNpc = state._activeNpc ?? undefined;
    nativeScriptDepth++;
    try { return executeScript.apply(this, args); } finally { nativeScriptDepth--; scriptNpc = previousNpc; }
};
const completeTask = (BotPlayer.prototype as any)._recordComplete;
(BotPlayer.prototype as any)._recordComplete = function (...args: any[]) {
    const name = this.currentTask?.name ?? 'unknown';
    completions[name] = (completions[name] ?? 0) + 1;
    return completeTask.apply(this, args);
};
let insideTaskLog = 0;
// Observe timeout diagnostics before either the legacy wall-clock throttle or the
// new logger can filter them. Emitted timeout lines are a separate volume metric.
for (const name of ['CombatTask', 'RangedMagicTask', 'RunecraftingTask', 'ThievingTask', 'CookingTask', 'SmithingTask', 'HerbloreTask']) {
    const module = await import(`#/engine/bot/tasks/${name}.js`);
    const prototype = module[name].prototype;
    const original = prototype._log;
    if (!original) continue;
    prototype._log = function (...args: unknown[]) {
        if (args.some(value => typeof value === 'string' && /timeout/i.test(value))) counters.timeoutDiagnostics++;
        insideTaskLog++;
        try { return original.apply(this, args); } finally { insideTaskLog--; }
    };
}
if (logModule) {
    const event=logModule.BotLog.event.bind(logModule.BotLog);
    logModule.BotLog.event=(...args) => {
        if (/^transport_(started|arrived|fare)$/.test(args[2])) {
            const leg=args[3].split(':')[0];
            const record=transportLegs[leg] ??= {started:0,arrived:0,coins:0};
            if(args[2]==='transport_started') record.started++;
            if(args[2]==='transport_arrived') record.arrived++;
            if(args[2]==='transport_fare') {const fare=Number(args[3].match(/: (\d+) coins/)?.[1]??0);record.coins+=fare;participation.faresPaid+=fare;}
        }
        event(...args);
    };
    const debug = logModule.BotLog.debug.bind(logModule.BotLog);
    logModule.BotLog.debug = (...values: unknown[]) => {
        if (!insideTaskLog && values.some(value => typeof value === 'string' && /timeout/i.test(value))) counters.timeoutDiagnostics++;
        debug(...values);
    };
}
const originalLog = BotPlayer.prototype.log;
BotPlayer.prototype.log = function (message: string, ...args: any[]) {
    const key = args[1];
    if (['path_failed', 'no_progress', 'obstacle_failed', 'navigation_stuck', 'navigation_oscillation'].includes(key)) {
        const name = this.activeTask?.name ?? 'unknown';
        navigationFailures[`${name}:${key}`] = (navigationFailures[`${name}:${key}`] ?? 0) + 1;
        if (failureSamples.length < 1000) failureSamples.push({ tick: World.currentTick, name: this.name, task: name,
            event: key, at: [this.player.x, this.player.z, this.player.level], destination: this.navigation.destinationLabel });
    }
    if (key === 'path_failed') counters.pathFailures++;
    if (key === 'no_progress') counters.noProgress++;
    if (key === 'task_deferred') {
        counters.taskDeferrals++;
        if (this.activeTask?.name === 'Combat') melee.deferrals++;
    }
    if (key === 'subtask_deferred') counters.subtaskDeferrals++;
    if (message.includes('[Navigation] oscillating')) {
        counters.oscillation++;
        const h = (this.movementMonitor as any).posHistory as number[];
        if (h && new Set(h).size <= 1) counters.stationaryOscillation++;
    }
    if (message.includes('[Navigation] stuck')) counters.stuck++;
    return originalLog.apply(this, [message, ...args] as Parameters<typeof originalLog>);
};
const originalSubtask = BotPlayer.prototype.setSubTask;
BotPlayer.prototype.setSubTask = function (task) {
    const before = (this as any).subTask;
    const result = originalSubtask.call(this, task);
    if ((this as any).subTask && (this as any).subTask !== before) counters.subtasksScheduled++;
    return result;
};
for (const method of ['log', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
        const message = args.map(String).join(' ');
        counters.logLines += message.split('\n').length;
        counters.logBytes += Buffer.byteLength(message + '\n');
        if (/timeout/i.test(message)) counters.timeoutMessages++;
        if (!logModule && !insideTaskLog && /timeout/i.test(message)) counters.timeoutDiagnostics++;
        if (/No sheep found/i.test(message)) counters.missingSheepMessages++;
        if (method === 'error') counters.errors++;
        original(...args);
    };
}
const actionXp = new Map<string, number>();
const actionLevels = new Map<string, number>();
const originalXp = Player.prototype.addXp;
Player.prototype.addXp = function (stat, xp, allowMulti = true) {
    const before = this.stats[stat];
    const beforeLevel = this.baseLevels[stat];
    originalXp.call(this, stat, xp, allowMulti);
    if (this.is_bot && World.currentTick >= 20) {
        if ((this as any)._bot?.activeTask?.name === 'Combat' && stat <= 2 && this.stats[stat] > before) {
            const delta = (this.stats[stat] - before) / 10;
            if (!nativeScriptDepth) melee.taskXp += delta;
            else {
                melee.nativeXp += delta;
                if (scriptNpc) {
                    const participants = fighters.get(scriptNpc) ?? new Set<bigint>();
                    if (!participants.has(this.hash64)) melee.damagingEngagements++;
                    participants.add(this.hash64);
                    fighters.set(scriptNpc, participants);
                }
            }
        }
        if(nativeScriptDepth>0) {nativeXp.set(this.username,(nativeXp.get(this.username)??0)+Math.max(0,this.stats[stat]-before)/10);xpThisTick.add(this.username);}
        actionXp.set(this.username, (actionXp.get(this.username) ?? 0) + Math.max(0, this.stats[stat] - before) / 10);
        actionLevels.set(this.username, (actionLevels.get(this.username) ?? 0) + Math.max(0, this.baseLevels[stat] - beforeLevel));
    }
};
const originalWaypoint = Player.prototype.queueWaypoint;
Player.prototype.queueWaypoint = function (x, z) {
    const dx = Math.sign(x - this.x);
    const dz = Math.sign(z - this.z);
    if (this.is_bot && (dx || dz) && !canTravel(this.level, this.x, this.z, dx, dz, 1, 0, CollisionType.NORMAL)) counters.blockedStepsQueued++;
    originalWaypoint.call(this, x, z);
};
const originalWaypoints = Player.prototype.queueWaypoints;
Player.prototype.queueWaypoints = function (points) {
    if (this.is_bot && points.length > 0) counters.routesQueued++;
    if (this.is_bot && points.length > 0 && Array.from(points).every(coord => ((coord >> 14) & 0x3fff) === this.x && (coord & 0x3fff) === this.z)) counters.noOpPathsQueued++;
    originalWaypoints.call(this, points);
};
const originalClear = Player.prototype.clearWaypoints;
Player.prototype.clearWaypoints = function () {
    if (this.is_bot && this.hasWaypoints()) counters.activeRoutesCleared++;
    originalClear.call(this);
};
const worldTimes: number[] = [];
const botTimes: number[] = [];
const travelSerial = new WeakMap<InstanceType<typeof BotPlayer>, number>();
const tasksSeen = new Map<string, Set<string>>();
const samples: unknown[] = [];
const manager = BotManager as any;
const originalTick = BotManager.tick.bind(BotManager);
BotManager.tick = () => {
    const start = performance.now();
    originalTick();
    botTimes.push(performance.now() - start);
    for (const bot of population()) {
        if (!tasksSeen.has(bot.name)) tasksSeen.set(bot.name, new Set());
        if (bot.currentTask) tasksSeen.get(bot.name)!.add(bot.currentTask.name);
        const modal = bot.player.modalMain;
        if (modals.get(bot.player) !== modal) {
            if (modal === 5292) services.bankOpened++;
            if (modal === 3824) services.shopOpened++;
            modals.set(bot.player, modal);
        }
        const name=bot.activeTask?.name??'Idle';
        const state=String((bot.activeTask as any)?.state??'');
        if(name==='Idle') participation.idleBotTicks++;
        else if(bot.player.hasWaypoints() || /walk|travel/.test(state)) participation.travelBotTicks++;
        else if(/^(Init|ShopTrip|Bank|Walk)$/.test(name)) participation.supportBotTicks++;
        else {participation.activityBotTicks++;if(!bot.planner.personality.name.startsWith('Extras'))participation.progressionActivityBotTicks++;}
        const serial = bot.navigation.meaningfulTravelSerial;
        if (name === 'Combat' && state === 'walk') melee.travelProgress += Math.max(0, serial - (travelSerial.get(bot) ?? serial));
        travelSerial.set(bot, serial);
        if(name==='Agility')participation.agilityTaskBotTicks++;
        if(xpThisTick.has(bot.name))participation.nativeXpBotTicks++;
    }
    xpThisTick.clear();
};
function population() {
    return [...manager.bots.values()] as InstanceType<typeof BotPlayer>[];
}
function progression() {
    return population().map(bot => {
        const p = bot.player;
        return {
            name: bot.name, personality: bot.planner.personality.name, task: bot.currentTask?.name,
            tasksSeen: [...tasksSeen.get(bot.name) ?? []],
            x: p.x, z: p.z, level: p.level, xp: Array.from(p.stats), levels: Array.from(p.baseLevels),
            nativeScriptXpGained: nativeXp.get(bot.name) ?? 0, xpGained: actionXp.get(bot.name) ?? 0,
            levelsGained: actionLevels.get(bot.name) ?? 0
        };
    });
}
function timing(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: values.length, meanMs: values.reduce((a, b) => a + b, 0) / values.length,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
        maxMs: sorted.at(-1), over600ms: values.filter(value => value > 600).length };
}
await World.start(false, false);
BotManager.init(World);
if (population().length !== 100) throw new Error(`Expected 100 configured bots, got ${population().length}`);
World.tickRate = interval; // Test-only condensation; the production 600ms constant stays unchanged.
const cycle = World.cycle.bind(World);
const wallStart = performance.now();
await new Promise<void>((resolve, reject) => {
    World.cycle = () => {
        if (World.currentTick >= ticks) { resolve(); return; }
        const prev = World.currentTick;
        const start = performance.now();
        cycle();
        worldTimes.push(performance.now() - start);
        observeObstacles();
        if (World.currentTick !== prev + 1) { reject(new Error('World cycle failed')); return; }
        if (World.currentTick % 1000 === 0) {
            const bots = progression();
            const sample = { tick: World.currentTick, active: World.getTotalPlayers(), xpGained: bots.reduce((sum, b) => sum + b.xpGained, 0), counters: { ...counters } };
            samples.push(sample);
            process.stderr.write(`SIM ${JSON.stringify(sample)}\n`);
        }
    };
    World.cycle();
});
observeObstacles(true);
const bots = progression();
const active = World.getTotalPlayers();
for (const bot of population()) World.removePlayer(bot.player);
const deadline = Date.now() + 30_000;
while (World.logoutRequests.size > 0 && Date.now() < deadline) {
    (World as any).processLogouts();
    await delay(10);
}
if (World.logoutRequests.size > 0) throw new Error('Player save flush timed out');
let verifiedSaves = 0;
for (const bot of population()) {
    const file = `data/players/bot-simulation/${bot.name}.sav`;
    const packet = new Packet(fs.readFileSync(file));
    if (!PlayerLoading.verify(packet)) throw new Error(`Save checksum failed for ${bot.name}`);
    packet.pos = 0;
    const loaded = PlayerLoading.load(bot.name, packet, null);
    if (!loaded || Array.from(loaded.stats).some((xp, i) => xp !== bots.find(b => b.name === bot.name)!.xp[i])) {
        throw new Error(`Save round trip failed for ${bot.name}`);
    }
    if (loaded.x !== bot.player.x || loaded.z !== bot.player.z || loaded.level !== bot.player.level) throw new Error(`Saved coordinates differ for ${bot.name}`);
    for (const [type, inv] of bot.player.invs) {
        if (InvType.get(type).scope !== InvType.SCOPE_PERM) continue;
        const restored = loaded.getInventory(type)!;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const expected = inv.get(slot);
            const actual = restored.get(slot);
            if (expected?.id !== actual?.id || expected?.count !== actual?.count) throw new Error(`Saved inventory differs for ${bot.name}, type ${type}, slot ${slot}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
        }
    }
    verifiedSaves++;
}
melee.unreachable = logModule?.BotLog.counts.target_unreachable ?? 0;
melee.noAttack = logModule?.BotLog.counts.no_attack_timeout ?? 0;
const report = { melee, seed, ticks, simulatedMinutes: ticks * 0.6 / 60, intervalMs: interval, wallSeconds: (performance.now() - wallStart) / 1000,
    version: process.env.BOT_SIM_LABEL ?? 'unspecified', sourceSha256: process.env.BOT_SIM_SOURCE_SHA256 ?? null,
    featureSupport: { navigationRetry: typeof BotPlayer.prototype.navigationFailed === 'function', taskDeferral: typeof BotPlayer.prototype.deferCurrentTask === 'function' },
    revision: Environment.ENGINE_REVISION,
    config: { xprate: Environment.NODE_XPRATE, progressiveXp: Environment.NODE_PROGRESSIVE_XP, debug: Environment.BOT_DEBUG_ENABLED,
        logLevel: process.env.BOT_LOG_LEVEL ?? 'info', verify: Environment.BUILD_VERIFY, verifyFolder: Environment.BUILD_VERIFY_FOLDER, verifyPack: Environment.BUILD_VERIFY_PACK },
    active, counters, navigationFailures, failureSamples, services, obstacles, participation, transportLegs, nativeScriptXpGained: [...nativeXp.values()].reduce((s,x)=>s+x,0), taskCompletions: completions, productionFingerprints: Object.fromEntries([
        'tasks/CombatTask.ts', 'BotGoalPlanner.ts', 'BotAction.ts', 'BotNavigation.ts', 'BotLocalRoute.ts', 'BotObstacles.ts', 'BotPlayer.ts', 'BotRouteRetry.ts', 'BotDialogue.ts', 'BotTravel.ts', 'tasks/BotTaskBase.ts', 'tasks/WoodcuttingTask.ts', 'tasks/MiningTask.ts', 'tasks/FishingTask.ts', 'tasks/ShopTripTask.ts', 'tasks/SocialTask.ts', 'tasks/AgilityTask.ts'
    ].map(file => [file, fs.existsSync(`src/engine/bot/${file}`) ? createHash('sha256').update(fs.readFileSync(`src/engine/bot/${file}`)).digest('hex') : null])), eventCounts: logModule?.BotLog.counts ?? null, worldTiming: timing(worldTimes), botTiming: timing(botTimes),
    steadyWorldTiming: timing(worldTimes.slice(20)), steadyBotTiming: timing(botTimes.slice(20)),
    xpGained: bots.reduce((sum, b) => sum + b.xpGained, 0), levelsGained: bots.reduce((sum, b) => sum + b.levelsGained, 0),
    botsWithXp: bots.filter(bot => bot.xpGained > 0).length, verifiedSaves,
    accounts: await db.selectFrom('account').select(db.fn.countAll().as('count')).executeTakeFirst(), samples, bots };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
await db.destroy();
const persisted = new DatabaseSync('db.sqlite');
(report as any).sqliteIntegrity = persisted.prepare('PRAGMA quick_check').get();
persisted.close();
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Simulation complete: ${output}`);
process.exit(0);
