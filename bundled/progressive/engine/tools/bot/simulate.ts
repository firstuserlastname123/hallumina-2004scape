/** Run only in a disposable assembled runtime. See docs/playerbot-reliability.md. */
import fs from 'node:fs';
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
const { BotPlayer } = await import('#/engine/bot/BotPlayer.js');
const { db } = await import('#/db/query.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: Environment } = await import('#/util/Environment.js');
const { default: Player } = await import('#/engine/entity/Player.js');
const { canTravel } = await import('#/engine/GameMap.js');
const { CollisionType } = await import('@2004scape/rsmod-pathfinder');
const logModule = fs.existsSync('src/engine/bot/BotLog.ts') ? await import('#/engine/bot/BotLog.js') : null;
const { default: Packet } = await import('#/io/Packet.js');
if (Environment.ENGINE_REVISION !== 254) throw new Error('This simulation requires revision 254.');

const counters = { oscillation: 0, stationaryOscillation: 0, stuck: 0, timeoutMessages: 0, timeoutDiagnostics: 0, missingSheepMessages: 0, logLines: 0, logBytes: 0, errors: 0, blockedStepsQueued: 0, noOpPathsQueued: 0 };
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
    const debug = logModule.BotLog.debug.bind(logModule.BotLog);
    logModule.BotLog.debug = (...values: unknown[]) => {
        if (!insideTaskLog && values.some(value => typeof value === 'string' && /timeout/i.test(value))) counters.timeoutDiagnostics++;
        debug(...values);
    };
}
const originalLog = BotPlayer.prototype.log;
BotPlayer.prototype.log = function (message: string, ...args: any[]) {
    if (message.includes('[Navigation] oscillating')) {
        counters.oscillation++;
        const h = (this.movementMonitor as any).posHistory as number[];
        if (h && new Set(h).size <= 1) counters.stationaryOscillation++;
    }
    if (message.includes('[Navigation] stuck')) counters.stuck++;
    return originalLog.apply(this, [message, ...args] as Parameters<typeof originalLog>);
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
    if (this.is_bot && points.length > 0 && Array.from(points).every(coord => ((coord >> 14) & 0x3fff) === this.x && (coord & 0x3fff) === this.z)) counters.noOpPathsQueued++;
    originalWaypoints.call(this, points);
};
const worldTimes: number[] = [];
const botTimes: number[] = [];
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
    }
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
            xpGained: actionXp.get(bot.name) ?? 0,
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
const report = { seed, ticks, simulatedMinutes: ticks * 0.6 / 60, intervalMs: interval, wallSeconds: (performance.now() - wallStart) / 1000,
    revision: Environment.ENGINE_REVISION,
    config: { xprate: Environment.NODE_XPRATE, progressiveXp: Environment.NODE_PROGRESSIVE_XP, debug: Environment.BOT_DEBUG_ENABLED,
        logLevel: process.env.BOT_LOG_LEVEL ?? 'info', verify: Environment.BUILD_VERIFY, verifyFolder: Environment.BUILD_VERIFY_FOLDER, verifyPack: Environment.BUILD_VERIFY_PACK },
    active, counters, eventCounts: logModule?.BotLog.counts ?? null, worldTiming: timing(worldTimes), botTiming: timing(botTimes),
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
