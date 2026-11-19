/**
 * BotManager.ts
 *
 * Spawns and ticks all bots.
 *
 * World.ts integration (3 changes):
 *
 *   1. Import at top of World.ts:
 *        import { BotManager } from '#/engine/bot/BotManager.js';
 *
 *   2. In start(), before this.cycle():
 *        BotManager.init(this);   // ← pass `this` (the World instance)
 *
 *   3. In cycle(), after this.processPlayers():
 *        BotManager.tick();
 *
 *   4. In processLogouts() — protect bots from timeout (see INSTALL.md)
 *
 * NOTE: BotManager does NOT import World. Instead it receives the World
 * instance via init(world) to avoid a circular import cycle:
 *   World → BotManager → [BotAction/BotTask] → World  (would be circular)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { setWorld, BotWorldHandle } from '#/engine/bot/BotWorld.js';
import { ensureBotAccount } from '#/engine/bot/BotDatabase.js';
import { BotGoalPlanner, makeSkiller, makeFighter, makeBalanced, makeRandom, makeAgilityTester, makeExtrasSocial, makeExtrasVendor, makeExtrasPKer, makeExtrasEdgevillePKer } from '#/engine/bot/BotGoalPlanner.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import { BotTutorial, needsBotTutorial } from '#/engine/bot/BotTutorial.js';
import Environment from '#/util/Environment.js';
import { toBase37, fromBase37 } from '#/util/JString.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';
import { BotLog, BOT_SUMMARY_TICKS, BOT_LOG_DETAILS } from '#/engine/bot/BotLog.js';
import { BotTickMetrics } from '#/engine/bot/BotTickMetrics.js';

/** Normalize a bot username the same way PlayerLoading does.
 *  RS2 base37 maps underscores → spaces and strips unsupported chars,
 *  so "araxxor_prime" becomes "araxxor prime", etc. */
function normalizeBotUsername(raw: string): string {
    return fromBase37(toBase37(raw));
}

const PLANNER_MAP = {
    skiller: makeSkiller,
    fighter: makeFighter,
    balanced: makeBalanced,
    random: makeRandom,
    agility_test: makeAgilityTester,
    extras_social: makeExtrasSocial,
    extras_vendor: makeExtrasVendor,
    extras_pker: makeExtrasPKer,
    extras_edgeville_pker: makeExtrasEdgevillePKer,
} as const;

type PlannerKey = keyof typeof PLANNER_MAP;

function loadBotConfigs(): BotConfig[] {
    const filePath = path.join(__dirname, 'bots.config.json');

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw);

        if (!Array.isArray(json)) {
            throw new Error('bots.config.json must be an array');
        }

        return json.map((b: any) => {
            const plannerKey = b.planner as PlannerKey;

            if (!PLANNER_MAP[plannerKey]) {
                throw new Error(`Invalid planner: ${b.planner}`);
            }

            return {
                username: b.username,
                description: b.description,
                planner: plannerKey,
                makePlanner: PLANNER_MAP[plannerKey]
            };
        });
    } catch (err) {
        console.error('[BotManager] Failed to load bots.config.json:', err);

        // fallback so server still boots
        return [];
    }
}

// ── Bot definitions ───────────────────────────────────────────────────────────

interface BotConfig {
    username: string;
    planner: PlannerKey;
    makePlanner: () => BotGoalPlanner;
    description: string;
}

const BOT_CONFIGS: BotConfig[] = loadBotConfigs();
const CONFIGURED_BOT_USERNAMES = new Set(BOT_CONFIGS.map(cfg => normalizeBotUsername(cfg.username)));

// ── BotManager singleton ──────────────────────────────────────────────────────

class BotManagerClass {
    private world: BotWorldHandle | null = null;
    private bots: Map<string, BotPlayer> = new Map();
    private prevLevels: Map<string, Uint8Array> = new Map();
    /** account_id for each bot — populated async after spawn via ensureBotAccount. */
    private accountIds: Map<string, number> = new Map();
    private spawned = false;
    private tickCount = 0;
    private lastSummaryTick = 0;
    private readonly botTimings = new BotTickMetrics();
    private readonly worldTimings = new BotTickMetrics();

    /**
     * Call from World.ts start() before this.cycle():
     *   BotManager.init(this);
     */
    init(world: BotWorldHandle): void {
        if (this.spawned) return;
        this.spawned = true;
        this.world = world;
        setWorld(world); // makes World available to BotAction/BotTask without import cycle
        BotCollisionMap.init('data/bot/unwalkable_tiles.csv');

        BotDebugService.configure();
        if (BotDebugService.enabled) {
            BotLog.debug(`[BotManager] Bot debugger ENABLED — dashboard at http://localhost:${Environment.WEB_PORT}/debug/bots (level=${BotDebugService.level})`);
        }

        BotLog.event('info', 'population', 'startup', `Spawning ${BOT_CONFIGS.length} configured bots`);
        for (const cfg of BOT_CONFIGS) this._spawnBot(cfg);
    }

    /** Call from World.ts cycle() after processPlayers(). */
    tick(): void {
        if (!this.world) return;

        // During shutdown the engine handles each bot's logout via the normal
        // removePlayer() → flushPlayer() → loginThread → LoginServer path.
        // LoginServer calls updateHiscores() and writes the .sav file there.
        // Stop ticking bots early so they don't take new actions while being
        // force-logged-out.
        if (this.world.shutdownSoon || this.world.shutdown) {
            return;
        }

        this.tickCount++;
        BotLog.tick = this.tickCount;

        const debugOn = BotDebugService.enabled;
        if (debugOn) BotDebugService.setTick(this.tickCount);
        const tickStart = performance.now();

        for (const bot of this.bots.values()) {
            if (bot.player.slot === -1) continue;

            if (debugOn) {
                const botTickStart = Date.now();
                bot.tick();
                BotDebugService.recordBotTickDuration(bot.name, Date.now() - botTickStart);
            } else {
                bot.tick();
            }
        }

        const elapsed = performance.now() - tickStart;
        this.botTimings.record(elapsed);
        if (debugOn) BotDebugService.recordGlobalTickDuration(elapsed);
    }

    /** Called after the complete world's game logic, independently of the dashboard. */
    recordWorldTick(ms: number): void {
        this.worldTimings.record(ms);
        if (!BOT_SUMMARY_TICKS || this.tickCount === this.lastSummaryTick || this.tickCount % BOT_SUMMARY_TICKS !== 0) return;
        this.lastSummaryTick = this.tickCount;
        const bots = [...this.bots.values()].filter(bot => bot.player.slot !== -1);
        const tasks: Record<string, number> = {};
        for (const bot of bots) tasks[bot.currentTask?.name ?? 'Idle'] = (tasks[bot.currentTask?.name ?? 'Idle'] ?? 0) + 1;
        const timing = (value: BotTickMetrics) => {
            const s = value.snapshot();
            return `${s.meanMs.toFixed(2)}/${s.p95Ms.toFixed(2)}/${s.maxMs.toFixed(2)}ms`;
        };
        BotLog.event('info', 'population', 'summary',
            `${bots.length}/${this.bots.size} active | tasks=${JSON.stringify(tasks)} | ` +
            `world mean/p95/max=${timing(this.worldTimings)} over600ms=${this.worldTimings.snapshot().over600ms} | ` +
            `bots mean/p95/max=${timing(this.botTimings)} | XP=${bots.reduce((sum, bot) => sum + bot.xpGained, 0).toFixed(1)} levels=${bots.reduce((sum, bot) => sum + bot.levelsGained, 0)} | ` +
            `events=${JSON.stringify(BotLog.counts)} rateLimited=${BotLog.suppressed}`, false);
        if (BOT_LOG_DETAILS && BotLog.level === 'debug') {
            for (const bot of bots) BotLog.event('debug', bot.name, 'status', JSON.stringify(bot.snapshot()));
        }
        this.botTimings.reset();
        this.worldTimings.reset();
    }

    isConfiguredBot(username: string): boolean {
        return CONFIGURED_BOT_USERNAMES.has(normalizeBotUsername(username));
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _spawnBot(cfg: BotConfig): void {
        if (!this.world) return;

        // Normalize username the same way PlayerLoading does:
        // base37 converts underscores to spaces, strips unsupported chars, lowercases.
        // e.g. "araxxor_prime" → "araxxor prime", "liluzivault" → "liluzivault"
        const normalizedUsername = normalizeBotUsername(cfg.username);
        const profile = Environment.NODE_PROFILE ?? 'main';

        const savePath = `data/players/${profile}/${normalizedUsername}.sav`;
        let save: Uint8Array | undefined;
        try {
            save = fs.readFileSync(savePath);
            if (save.length < 2) {
                console.error(`[BotManager] Empty save for ${normalizedUsername}; skipping bot startup`);
                return;
            }
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.error(`[BotManager] Could not read save for ${normalizedUsername}; skipping bot startup`, err);
                return;
            }
        }

        let player;
        try {
            player = PlayerLoading.load(normalizedUsername, new Packet(save ?? new Uint8Array()), null);
        } catch (err) {
            console.error(`[BotManager] Could not load save for ${normalizedUsername}; skipping bot startup`, err);
            return;
        }

        player.is_bot = true;
        player.botPlanner = cfg.planner;
        player.botTutorialPending ||= save === undefined;
        const planner = cfg.makePlanner();
        planner.useNativeStarterKit();
        const tutorial = needsBotTutorial(player) ? new BotTutorial() : undefined;
        const bot = new BotPlayer(player, planner, tutorial);
        this.bots.set(normalizedUsername, bot);
        this.prevLevels.set(normalizedUsername, new Uint8Array(player.baseLevels));
        this.world.newPlayers.add(player);

        BotLog.debug(`[BotManager] Loaded bot: ${normalizedUsername}`);

        // Ensure a DB account row exists so LoginServer can find this bot during
        // the player_logout flow (by player.username = normalizedUsername), and
        // store the id for periodic hiscore updates.
        // NOTE: must use normalizedUsername — LoginServer looks up accounts by
        // player.username (spaces), so the DB row must also use the normalized form.
        ensureBotAccount(normalizedUsername)
            .then(id => {
                if (id !== null) this.accountIds.set(normalizedUsername, id);
            })
            .catch(err => console.error(`[BotManager] ensureBotAccount failed for ${normalizedUsername}:`, err));
    }

}

export const BotManager = new BotManagerClass();
