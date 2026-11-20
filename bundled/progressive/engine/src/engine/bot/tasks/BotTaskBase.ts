/**
 * BotTaskBase.ts
 *
 * Shared imports, helpers, constants, and the abstract BotTask base class.
 * All task files import from here.
 */

import { chooseTravel, onTutorialIsland } from '#/engine/bot/BotTravel.js';
import { findReachableLoc, findReachableNpc, npcMatchesName } from '#/engine/bot/BotAction.js';
import { findLocApproach, findNpcApproach, findTileRoute, botPathCost } from '#/engine/bot/BotNavigation.js';
import Player from '#/engine/entity/Player.js';
import Npc from '#/engine/entity/Npc.js';
import LocType from '#/cache/config/LocType.js';
import Loc from '#/engine/entity/Loc.js';
import InvType from '#/cache/config/InvType.js';
import { Inventory } from '#/engine/Inventory.js';
import {
    walkTo,
    interactNpc,
    interactNpcOp,
    interactLoc,
    interactLocOp,
    interactUseLocOp,
    interactUseObjNpcOp,
    botInteractUseObjNpc,
    findNpcByName,
    findNpcByNameExcluding,
    findNpcByPrefix,
    findNpcBySuffix,
    findLocByPrefix,
    findLocByPrefixWhere,
    findLocByName,
    findLocByNameWhere,
    hasItem,
    countItem,
    addItem,
    removeItem,
    isInventoryFull,
    getBaseLevel,
    PlayerStat,
    hasWaypoints,
    addXp,
    setCombatStyle,
    setAutocastWindStrike,
    setAutocastSpell,
    openNearbyGate,
    isAdjacentToLoc,
    botTeleport
} from '#/engine/bot/BotAction.js';
import { Items, Shops, Locations, getProgressionStep, GRIMY_HERB_MAP, FOOD_IDS } from '#/engine/bot/BotKnowledge.js';
import { isMapBlocked, isZoneAllocated } from '#/engine/GameMap.js';
import type { SkillStep } from '#/engine/bot/BotKnowledge.js';
import { getMissingPurchases, STARTING_COINS } from '#/engine/bot/BotNeeds.js';
import type { Purchase } from '#/engine/bot/BotNeeds.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ticks before assuming an interaction failed (no XP / no response). */
export const INTERACT_TIMEOUT = 20;

/** Teleport destination when a bot is hopelessly stuck. */
const SAFE_SPAWN: [number, number, number] = Locations.LUMBRIDGE_SPAWN;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isNear(player: Player, x: number, z: number, dist: number, level = 0): boolean {
    return player.level === level && Math.abs(player.x - x) <= dist && Math.abs(player.z - z) <= dist;
}

/** Returns the bank inventory ID, or -1 if not loaded. */
export function bankInvId(): number {
    try {
        return InvType.getId('bank');
    } catch {
        return -1;
    }
}

/**
 * Teleport bot to Lumbridge spawn — used when stuck with no path forward.
 * Plays the magic teleport animation so other players see the cast effect.
 */
export function teleportToSafety(player: Player): void {
    const [x, z, level] = SAFE_SPAWN;
    botTeleport(player, x, z, level);
}

/**
 * Teleport bot to (x, z, level). Defaults to level 0 (ground floor) because
 * all bot skill destinations and banks are on the ground floor — using
 * player.level caused bots on floor 2 to land inside roofs.
 */
export function teleportNear(player: Player, x: number, z: number, level = 0): void {
    botTeleport(player, x, z, level);
}

/**
 * Return a stable per-bot jitter offset so different bots spread around a
 * shared destination instead of all walking to the exact same tile.
 *
 * Uses the player's slot number as a deterministic seed so the offset is
 * consistent for each bot across ticks (no per-tick re-randomisation).
 *
 * @param radius  Maximum tile offset in each axis (default 5).
 */
// ── Nearest-bank helper ───────────────────────────────────────────────────────

/**
 * All bot-accessible banks on the ground floor.
 * Lumbridge castle 2nd-floor bank is intentionally excluded — bots don't
 * climb stairs.  Al Kharid bank is included; the GATEWAY_REGIONS routing in
 * walkTo handles the gate automatically.
 */
const BOT_BANKS: ReadonlyArray<[number, number, number]> = [
    Locations.DRAYNOR_BANK,
    Locations.VARROCK_WEST_BANK,
    Locations.VARROCK_EAST_BANK,
    Locations.AL_KHARID_BANK,
    Locations.FALADOR_WEST_BANK,
    Locations.FALADOR_EAST_BANK,
    Locations.SEERS_BANK,
    Locations.EDGEVILLE_BANK,
    Locations.YANILLE_BANK,
    Locations.CATHERBY_BANK,
    Locations.ARDOUGNE_NORTH_BANK,
    Locations.ARDOUGNE_SOUTH_BANK,
    Locations.GNOME_NORTH_BANK,
    Locations.GNOME_SOUTH_BANK
];

/**
 * Returns the [x, z, level] tuple of the bank closest to the player's
 * current tile, using reachable local paths and estimated native travel costs. Call once
 * per banking state entry rather than hard-coding a single bank.
 */
/** Exact local costs and native travel requirements; remote land costs remain estimates. */
function bankChoices(player: Player, reference?: [number, number, number]): [number, number, number][] {
    const candidates: { bank: [number, number, number]; cost: number }[] = [];
    for (const bank of BOT_BANKS) {
        if (onTutorialIsland(player.x, player.z) !== onTutorialIsland(bank[0], bank[1])) continue;
        const travel = chooseTravel(player, bank[0], bank[1]);
        if (!['land', 'ship', 'tunnel'].includes(travel.mode)) continue;
        const distance = Math.max(Math.abs(bank[0] - player.x), Math.abs(bank[1] - player.z));
        let cost = distance + (bank[2] === player.level ? 0 : 100);
        if (bank[2] === player.level && distance <= 60) {
            const route = findTileRoute(player.level, player.x, player.z, bank[0], bank[1]);
            if (!route) continue;
            cost = botPathCost(player.x, player.z, route.path);
        } else if (travel.legs.length) {
            let x = player.x, z = player.z;
            cost = 0;
            for (const leg of travel.legs) {
                cost += Math.max(Math.abs(x - leg.from.x), Math.abs(z - leg.from.z)) + 25 + leg.fare;
                x = leg.to.x; z = leg.to.z;
            }
            cost += Math.max(Math.abs(x - bank[0]), Math.abs(z - bank[1]));
        }
        if (reference) cost += Math.max(Math.abs(bank[0] - reference[0]), Math.abs(bank[1] - reference[1]));
        candidates.push({ bank, cost });
    }
    return candidates.sort((a, b) => a.cost - b.cost).map(candidate => candidate.bank);
}

export function nearestBank(player: Player): [number, number, number] {
    return bankChoices(player)[0] ?? nearestBankTo(player.x, player.z);
}

/**
 * Returns the bank closest to an arbitrary coordinate — use this when the
 * relevant reference point is the skill activity location rather than where
 * the player currently stands (e.g. cooking range, furnace).
 */
export function nearestBankTo(x: number, z: number): [number, number, number] {
    let best = BOT_BANKS[0];
    let bestDist = Number.MAX_SAFE_INTEGER;
    for (const bank of BOT_BANKS) {
        const dist = Math.max(Math.abs(x - bank[0]), Math.abs(z - bank[1]));
        if (dist < bestDist) {
            bestDist = dist;
            best = bank;
        }
    }
    return best;
}

// ── botJitter ─────────────────────────────────────────────────────────────────

/**
 * Prime-pair seeds used by botJitter's fallback sequence.
 * Each entry produces a different (jx, jz) spread for the same slot number.
 * Keeping them here as a constant avoids re-allocating the array every tick.
 */
const JITTER_SEEDS: ReadonlyArray<[mx: number, mz: number, bx: number, bz: number]> = [
    [7, 13, 3, 7],
    [11, 17, 5, 11],
    [19, 23, 7, 13],
    [29, 31, 11, 17],
    [37, 41, 13, 19]
];

export function botJitter(player: Player, x: number, z: number, radius = 5): [number, number] {
    const slot = (player as any).slot ?? 0;
    const level = player.level;
    const span = radius * 2 + 1;

    // Try each deterministic seed in order until we land on a walkable tile.
    // Using the slot as the hash input keeps the result stable across ticks
    // (same bot always gets the same jittered destination for a given area).
    for (const [mx, mz, bx, bz] of JITTER_SEEDS) {
        const tx = x + ((slot * mx + bx) % span) - radius;
        const tz = z + ((slot * mz + bz) % span) - radius;
        if (isZoneAllocated(level, tx, tz) && !isMapBlocked(tx, tz, level)) {
            return [tx, tz];
        }
    }

    // All offsets are blocked — return the base tile unchanged
    return [x, z];
}

// ── Abstract base ─────────────────────────────────────────────────────────────

export abstract class BotTask {
    readonly name: string;
    interrupted = false;
    protected cooldown = 0;
    protected rescanTimer = 0;

    protected constructor(name: string) {
        this.name = name;
    }

    abstract shouldRun(player: Player): boolean;
    abstract tick(player: Player): void;
    abstract isComplete(player: Player): boolean;

    /**
     * Optional structured diagnostics for the bot debugger. Tasks are not
     * required to implement this — BotDebugService falls back to reading a
     * `.state` field off the instance when it's absent. Override this on
     * tasks where richer diagnostics (target, destination, extra details)
     * are worth exposing. Never called from gameplay code, only from the
     * debug snapshot builder, and always wrapped in try/catch by the caller.
     */
    getDebugInfo?(player: Player): BotTaskDebugInfo;

    interrupt(): void {
        this.interrupted = true;
    }
    reset(): void {
        this.interrupted = false;
        this.cooldown = 0;
        this.rescanTimer = 0;
    }
}

// Re-export everything tasks need so they only import from this one file
export type { SkillStep } from '#/engine/bot/BotKnowledge.js';
export {
    Player,
    Npc,
    Loc,
    InvType,
    Inventory,
    walkTo,
    interactNpc,
    interactNpcOp,
    interactLoc,
    interactLocOp,
    interactUseLocOp,
    findNpcByName,
    findNpcByPrefix,
    findNpcBySuffix,
    findLocByPrefix,
    findLocByPrefixWhere,
    findLocByName,
    findLocByNameWhere,
    hasItem,
    countItem,
    addItem,
    removeItem,
    isInventoryFull,
    getBaseLevel,
    PlayerStat,
    hasWaypoints,
    addXp,
    setCombatStyle,
    setAutocastWindStrike,
    setAutocastSpell,
    Items,
    Shops,
    Locations,
    getProgressionStep,
    FOOD_IDS,
    getMissingPurchases,
    STARTING_COINS,
    openNearbyGate,
    isAdjacentToLoc,
    interactUseObjNpcOp,
    botInteractUseObjNpc,
    findNpcByNameExcluding,
    botTeleport
};
export type { WindSpellTier, ToolRequirement } from '#/engine/bot/BotKnowledge.js';
export { WIND_SPELLS, pickBestWindSpell, RangedBowsByLevel, bestRangedBow, RangedArrowsByCost, bestAffordableArrow } from '#/engine/bot/BotKnowledge.js';

// ── Shared banking helper ─────────────────────────────────────────────────────

/**
 * Drives the 'bank_walk' state for any gathering task.
 *
 * Priority order:
 *   1. Bank booth (bankbooth loc, op2 = Use-quickly → @openbank immediately, no dialog).
 *      Works at ALL banks.  Avoids NPC name ambiguity entirely.
 *   2. Banker NPC by prefix 'banker' (Lumbridge 2nd floor, Draynor, Varrock…).
 *   3. Banker NPC by prefix 'kharidbanker' (Al Kharid — debug name starts with 'kharid').
 *   4. Hold another available bank destination when local services are unreachable.
 *
 * Pass null for the stuck detector to use only shared navigation recovery.
 *
 * Returns:
 *   'walk'   — still navigating, caller should return for this tick
 *   'ready'  — a native bank interaction is queued; set cooldown + state
 * The legacy 'direct' type remains for existing callers but is never returned.
 */
type BankTrip = { owner: unknown; destination: [number, number, number]; unavailable: Set<string>; lastFailures: number };
const bankTrips = new WeakMap<Player, BankTrip>();

export function advanceBankWalk(
    player: Player,
    stuckDetector: StuckDetector | null,
    activityCoord?: [number, number, number],
): 'walk' | 'ready' | 'direct' {
    const bot = (player as any)._bot;
    let trip = bankTrips.get(player);
    if (!trip || trip.owner !== bot?.activeTask) {
        const destination = bankChoices(player, activityCoord)[0];
        if (!destination) { bot?.deferCurrentTask('no available bank journey'); return 'walk'; }
        trip = { owner: bot?.activeTask, destination, unavailable: new Set(), lastFailures: 0 };
        bankTrips.set(player, trip);
    }
    const alternative = () => {
        trip!.unavailable.add(trip!.destination.join(','));
        const next = bankChoices(player, activityCoord).find(bank => !trip!.unavailable.has(bank.join(',')));
        if (!next) bot?.deferCurrentTask('no reachable bank service');
        else { trip!.destination = next; stuckDetector?.reset(); }
    };
    // Preserve the task's bounded retry budget while choosing another service.
    const failures = bot?.navigation.failures ?? 0;
    if (failures >= 2 && failures > trip.lastFailures) alternative();
    trip.lastFailures = failures;
    if (bot?.activeTask?.interrupted) return 'walk';
    const [bx, bz, bl] = trip.destination;

    if (!isNear(player, bx, bz, 3, bl)) {
        // Still walking — drive bot all the way to the bank coord (which should be
        // inside the building) before the booth search activates.
        walkTo(player, bx, bz, bl);
        return 'walk';
    }

    // ── At bank (inside): try booth first ────────────────────────────────────
    // Search radius 6 — large enough to find booths across the floor but small
    // enough not to reach through the walls of the building from outside.
    // The bot is already at the interior coord so no wall-pierce is possible.
    const booth = findReachableLoc(player, 6, loc => LocType.get(loc.type).debugname?.startsWith('bankbooth') ?? false);
    if (booth) {
        if (!player.inOperableDistance(booth)) {
            const approach = findLocApproach(player, booth)!;
            walkTo(player, approach.x, approach.z, booth.level);
            return 'walk';
        }
        bankTrips.delete(player);
        interactLocOp(player, booth, 2); // op2 = Use-quickly → @openbank, no dialog
        return 'ready';
    }

    // ── Fallback: banker NPC ──────────────────────────────────────────────────
    // Al Kharid bankers have debug names starting with 'kharidbanker', not 'banker'.
    const banker = findReachableNpc(player, 10, npc => npcMatchesName(npc, 'banker') || npcMatchesName(npc, 'kharidbanker'));
    if (banker) {
        if (!player.inOperableDistance(banker)) {
            const approach = findNpcApproach(player, banker)!;
            walkTo(player, approach.x, approach.z, banker.level);
            return 'walk';
        }
        bankTrips.delete(player);
        interactNpcOp(player, banker, 3); // op3 = Bank on standard bankers
        return 'ready';
    }

    // This bank has no reachable service. Hold another destination for the trip.
    alternative();
    return 'walk';
}

// ── StuckDetector ─────────────────────────────────────────────────────────────

/**
 * Detects both stationary AND oscillating bots.
 *
 * Every WINDOW ticks, compares current distance-to-destination against the
 * snapshot taken WINDOW ticks ago. If the bot hasn't closed the gap by at
 * least MIN_PROGRESS tiles, it's considered stuck — regardless of whether it
 * was stationary or bouncing back and forth.
 */
export class StuckDetector {
    private readonly window: number;
    private readonly minProgress: number;
    private readonly freezeRadius: number;

    private ticks = 0;
    private snapshotDist = -1;
    private snapshotX = -1;
    private snapshotZ = -1;
    private escapeCount = 0;

    private readonly escapeLimit: number;

    /**
     * @param windowTicks       How many ticks between progress checks
     * @param minProgressTiles  Minimum tiles of progress required per window
     * @param escapeLimit       Consecutive failed escape attempts before desperatelyStuck (default 3)
     * @param freezeRadius      If the bot hasn't moved more than this many tiles from its
     *                          snapshot position, skip straight to desperatelyStuck (default 3)
     */
    constructor(windowTicks = 40, minProgressTiles = 5, escapeLimit = 3, freezeRadius = 3) {
        this.window = windowTicks;
        this.minProgress = minProgressTiles;
        this.escapeLimit = escapeLimit;
        this.freezeRadius = freezeRadius;
    }

    /**
     * Call once per walk tick. Returns true when the bot is stuck.
     * If the bot hasn't moved more than freezeRadius tiles from its snapshot
     * position (oscillating or stationary), desperatelyStuck is set immediately
     * so the caller teleports without wasting ticks on detour attempts.
     */
    check(player: { x: number; z: number }, destX: number, destZ: number): boolean {
        if (this.snapshotDist < 0) {
            // Seed snapshot on very first call so the window starts immediately.
            this.snapshotDist = Math.abs(player.x - destX) + Math.abs(player.z - destZ);
            this.snapshotX = player.x;
            this.snapshotZ = player.z;
        }

        if (++this.ticks < this.window) return false;
        this.ticks = 0;

        const dist = Math.abs(player.x - destX) + Math.abs(player.z - destZ);
        const progress = this.snapshotDist - dist;
        const moved = Math.max(Math.abs(player.x - this.snapshotX), Math.abs(player.z - this.snapshotZ));

        this.snapshotDist = dist;
        this.snapshotX = player.x;
        this.snapshotZ = player.z;

        // Bot hasn't left a 3-tile area — oscillating or frozen. Skip detours.
        if (moved <= this.freezeRadius) {
            this.escapeCount = this.escapeLimit;
            return true;
        }

        if (progress < this.minProgress) {
            this.escapeCount++;
            return true;
        }
        this.escapeCount = 0;
        return false;
    }

    /** True after escapeLimit+ failed escapes — teleport rather than detour. */
    get desperatelyStuck(): boolean {
        return this.escapeCount >= this.escapeLimit;
    }

    /** Read-only diagnostic snapshot for the bot debugger — never used by gameplay logic. */
    getDebugSnapshot(): { ticks: number; window: number; minProgress: number; snapshotDist: number; escapeCount: number; escapeLimit: number; desperatelyStuck: boolean } {
        return {
            ticks: this.ticks,
            window: this.window,
            minProgress: this.minProgress,
            snapshotDist: this.snapshotDist,
            escapeCount: this.escapeCount,
            escapeLimit: this.escapeLimit,
            desperatelyStuck: this.desperatelyStuck
        };
    }

    reset(): void {
        this.ticks = 0;
        this.snapshotDist = -1;
        this.snapshotX = -1;
        this.snapshotZ = -1;
        this.escapeCount = 0;
    }
}

// ── ProgressWatchdog ──────────────────────────────────────────────────────────

/**
 * XP-stall watchdog — measures real progress by XP gain, not by position.
 *
 * Counts ticks without a `notifyActivity()` call. If the stall exceeds the
 * limit the task is deferred. Banking states can be paused so a
 * legitimate bank trip doesn't trigger a false rescue.
 *
 * Usage in a task's tick():
 *   const banking = this.state === 'bank_walk' || this.state === 'bank_done';
 *   if (this.watchdog.check(player, banking)) { this.stuck.reset(); return; }
 *
 * When XP is gained:
 *   this.watchdog.notifyActivity();
 *
 * Why position-based detection doesn't work:
 *   A bot oscillating between (3210,3198) and (3230,3194) moves ~24 tiles
 *   every window, always appearing to make progress.
 */
export class ProgressWatchdog {
    private readonly limit: number;
    private stallTicks = 0;
    private travelSerial = -1;

    /**
     * Activity destination retained for callers' diagnostics. A stall never
     * grants travel to this tile.
     */
    destination?: [number, number, number];

    /**
     * @param stallTickLimit Ticks without activity before task deferral.
     *                        Short enough to rescue stuck bots quickly, but long enough
     *                        to cover legitimate bank trips and mid-walk delays.
     */
    constructor(stallTickLimit = 300) {
        this.limit = stallTickLimit;
    }

    /** Call when XP was gained. Resets the stall counter. */
    notifyActivity(): void {
        this.stallTicks = 0;
    }

    /**
     * Call every tick. Pass `paused=true` when the task is in a banking state
     * to avoid triggering during legitimate bank trips.
     *
     * Returns true if the task was deferred (the caller should return).
     */
    check(player: Player, paused = false): boolean {
        if (paused) return false;
        const serial = (player as any)._bot?.navigation.meaningfulTravelSerial;
        if (serial !== undefined && serial !== this.travelSerial) {
            if (this.travelSerial !== -1) this.stallTicks = 0;
            this.travelSerial = serial;
        }
        if (++this.stallTicks < this.limit) return false;
        (player as any)._bot?.deferCurrentTask('activity watchdog: no progress');
        this.reset();
        return true;
    }

    reset(): void {
        this.stallTicks = 0;
    }
}

/**
 * Cleans any grimy herbs in the player's inventory and awards Herblore XP.
 * Call this just before banking so cleaned herbs are banked instead of grimy ones.
 */
export function cleanGrimyHerbs(player: Player): void {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        const entry = GRIMY_HERB_MAP[item.id];
        if (!entry) continue;
        const [cleanId, xp] = entry;
        const removed = inv.remove(item.id, item.count);
        if (removed.completed > 0) {
            inv.add(cleanId, removed.completed);
            addXp(player, PlayerStat.HERBLORE, xp * removed.completed);
        }
    }
}

/**
 * True if the inventory holds anything other than coins or an item in
 * keepIds (tools, an in-flight consumable). Used by gathering tasks to spot
 * leftover junk from a previous task — a leftover pickaxe, ore, loot, etc. —
 * before heading out to a fresh location, so the bot banks it first instead
 * of carrying dead weight around for an entire trip.
 */
export function hasStrayItems(player: Player, keepIds: number[]): boolean {
    const inv = player.getInventory(InvType.INV);
    if (!inv) return false;
    for (let slot = 0; slot < inv.capacity; slot++) {
        const item = inv.get(slot);
        if (!item) continue;
        if (item.id === Items.COINS) continue;
        if (keepIds.includes(item.id)) continue;
        return true;
    }
    return false;
}

// ── Loc claim registry ───────────────────────────────────────────────────────
//
// Trees/rocks have no per-bot "target" field the way NPCs do (CombatTask uses
// npc.target to detect an NPC already being fought), so without this, every
// bot searching from roughly the same spot deterministically finds the exact
// same nearest tree/rock — findLocByPrefix always returns the single closest
// match. Multiple bots then converge on one resource, block each other from
// the one reachable adjacent tile, and cycle approach-timeout/retry forever,
// which from the outside looks like bots "stuck" standing next to a tree.
//
// Mirrors CombatTask's CLAIMED_NPCS pattern, but for Locs.
const CLAIMED_LOCS = new Set<string>();

function _locKey(loc: Loc): string {
    return `${loc.level}:${loc.x}:${loc.z}`;
}

/** Register a Loc as claimed so other bots' searches skip it. */
export function claimLoc(loc: Loc): void {
    CLAIMED_LOCS.add(_locKey(loc));
}

/** Release a previously-claimed Loc (felled/depleted, task reset, moved on). */
export function releaseLoc(loc: Loc | null): void {
    if (loc) CLAIMED_LOCS.delete(_locKey(loc));
}

export function isLocClaimed(loc: Loc): boolean {
    return CLAIMED_LOCS.has(_locKey(loc));
}
