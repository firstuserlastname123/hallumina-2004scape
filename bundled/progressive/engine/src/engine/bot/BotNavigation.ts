/**
 * BotNavigation.ts
 *
 * Central navigation layer for bot movement.  All bot path generation and
 * movement validation goes through here so tasks benefit automatically.
 *
 * Architecture:
 *
 *   BotTask / BotAction.walkTo()
 *          ↓
 *     BotNavigation          ← this file
 *       canBotStep()         — engine canTravel + CSV check
 *       trimPathAtCsvBlock() — strip CSV-blocked steps from rsmod path
 *       findNearestWalkableTile() — fallback when destination is blocked
 *          ↓
 *   rsmod pathfinder (botWalkPath / canTravel)
 *   +
 *   BotCollisionMap.isCsvBlocked()
 *
 * Directional wall/fence collision is handled entirely by the rsmod pathfinder
 * via canTravel() and botWalkPath().  The CSV is a supplementary rejection layer
 * only — it cannot and does not express directional collision.
 *
 * BotMovementMonitor (per-bot instance):
 *   - Tracks position history each tick
 *   - Detects stuck (waypoints active but no position change for N ticks)
 *   - Detects oscillation (A→B→A→B or A→B→C→A→B→C cycles)
 *   - Maintains a short-lived failed-edge cache
 */

import { findLocalRoute } from '#/engine/bot/BotLocalRoute.js';
import { CollisionFlag, CollisionType } from '@2004scape/rsmod-pathfinder';
import { canTravel, isMapBlocked, botFindPath, findPathToLoc, reachedLoc, findPathToEntity, reachedEntity } from '#/engine/GameMap.js';
import { BotCollisionMap } from '#/engine/bot/BotCollisionMap.js';
import LocType from '#/cache/config/LocType.js';
import type Loc from '#/engine/entity/Loc.js';
import type Player from '#/engine/entity/Player.js';
import type Npc from '#/engine/entity/Npc.js';

export type BotApproach = { x: number; z: number; path: Uint32Array };

/** Walking tiles, rather than the number of compressed turns. */
export function botPathCost(srcX: number, srcZ: number, path: Uint32Array): number {
    let cost = 0;
    for (const point of path) {
        const x = (point >> 14) & 0x3fff;
        const z = point & 0x3fff;
        cost += Math.max(Math.abs(x - srcX), Math.abs(z - srcZ));
        srcX = x; srcZ = z;
    }
    return cost;
}

/** Exact local tile route. A move-near endpoint is not proof of reachability. */
export function findTileRoute(level: number, srcX: number, srcZ: number, x: number, z: number): BotApproach | null {
    if (isBotTileBlocked(level, x, z)) return null;
    if (srcX === x && srcZ === z) return { x, z, path: new Uint32Array() };
    const path = trimPathAtCsvBlock(level, botFindPath(level, srcX, srcZ, x, z), srcX, srcZ);
    if (!path.length) return null;
    const end = path[path.length - 1];
    if (((end >> 14) & 0x3fff) === x && (end & 0x3fff) === z && validateBotPath(level, srcX, srcZ, path) === 'ok') return { x, z, path };
    const detour = findLocalRoute(level, srcX, srcZ, x, z,
        (x, z, nx, nz) => canBotStep(level, x, z, nx, nz), (tx, tz) => tx === x && tz === z);
    return detour ? { x, z, path: detour } : null;
}

/** Legal entity face, shared by gathering, shops and melee selection. */
export function findNpcApproach(player: Player, npc: Npc): BotApproach | null {
    if (player.level !== npc.level || !npc.isActive) return null;
    if (player.inOperableDistance(npc)) return { x: player.x, z: player.z, path: new Uint32Array() };
    const path = trimPathAtCsvBlock(player.level, findPathToEntity(player.level, player.x, player.z,
        npc.x, npc.z, player.width, npc.width, npc.length), player.x, player.z);
    if (!path.length) return null;
    const end = path[path.length - 1];
    const x = (end >> 14) & 0x3fff, z = end & 0x3fff;
    if (!reachedEntity(player.level, x, z, npc.x, npc.z, npc.width, npc.length, player.width) ||
        validateBotPath(player.level, player.x, player.z, path) !== 'ok') {
        const detour = findLocalRoute(player.level, player.x, player.z, npc.x, npc.z,
            (x, z, nx, nz) => canBotStep(player.level, x, z, nx, nz),
            (x, z) => reachedEntity(player.level, x, z, npc.x, npc.z, npc.width, npc.length, player.width), Math.max(npc.width, npc.length));
        if (!detour?.length) return null;
        const end = detour[detour.length - 1];
        return { x: (end >> 14) & 0x3fff, z: end & 0x3fff, path: detour };
    }
    return { x, z, path };
}

/** Bounded local choice; never treats a nearby but disconnected object as usable. */
export function chooseReachable<T extends { x: number; z: number }>(player: Player, candidates: T[],
    approach: (target: T) => BotApproach | null, penalty: (target: T) => number = () => 0): { target: T; approach: BotApproach; cost: number } | null {
    const distance = (target: T) => Math.max(Math.abs(target.x - player.x), Math.abs(target.z - player.z));
    candidates.sort((a, b) => distance(a) - distance(b));
    let best: { target: T; approach: BotApproach; cost: number } | null = null;
    for (const target of candidates.slice(0, 24)) {
        const route = approach(target);
        if (!route) continue;
        const cost = botPathCost(player.x, player.z, route.path) + penalty(target);
        if (!best || cost < best.cost) best = { target, approach: route, cost };
    }
    return best;
}

/** A real, reachable operating position, respecting rotation and forceapproach. */
export function findLocApproach(player: Player, loc: Loc): { x: number; z: number; path: Uint32Array } | null {
    if (player.level !== loc.level || !loc.isValid()) return null;
    const forceapproach = LocType.get(loc.type).forceapproach;
    const operable = (x: number, z: number) => reachedLoc(loc.level, x, z, loc.x, loc.z,
        loc.width, loc.length, player.width, loc.angle, loc.shape, forceapproach);
    if (!isBotTileBlocked(player.level, player.x, player.z) && operable(player.x, player.z)) {
        return { x: player.x, z: player.z, path: new Uint32Array() };
    }
    const accept = (path: Uint32Array) => {
        const safe = trimPathAtCsvBlock(player.level, path, player.x, player.z);
        if (!safe.length) return null;
        const end = safe[safe.length - 1];
        const x = (end >> 14) & 0x3fff;
        const z = end & 0x3fff;
        if (isBotTileBlocked(player.level, x, z) || !operable(x, z) || validateBotPath(player.level, player.x, player.z, safe) !== 'ok') return null;
        return { x, z, path: safe };
    };
    const native = accept(findPathToLoc(player.level, player.x, player.z, loc.x, loc.z,
        player.width, loc.width, loc.length, loc.angle, loc.shape, forceapproach));
    if (native) return native;
    // The supplementary CSV may reject the native endpoint. Try the other
    // legal faces, rather than settling for a merely nearby or blocked tile.
    const candidates: { x: number; z: number }[] = [];
    for (let x = loc.x - 1; x <= loc.x + loc.width; x++) {
        for (let z = loc.z - 1; z <= loc.z + loc.length; z++) {
            if (!isBotTileBlocked(player.level, x, z) && operable(x, z)) candidates.push({ x, z });
        }
    }
    candidates.sort((a, b) => Math.max(Math.abs(a.x - player.x), Math.abs(a.z - player.z)) -
        Math.max(Math.abs(b.x - player.x), Math.abs(b.z - player.z)));
    for (const tile of candidates) {
        const path = findTileRoute(player.level, player.x, player.z, tile.x, tile.z)?.path;
        const route = path ? accept(path) : null;
        if (route) return route;
    }
    return null;
}

// ── canBotStep ────────────────────────────────────────────────────────────────

/**
 * Returns true if a bot can step from (x, z) to (nx, nz) on the given level.
 *
 * Combines TWO independent checks:
 *   1. Engine collision via canTravel() — handles directional walls, fences,
 *      blocked tiles, and diagonal corner-cutting correctly.
 *   2. CSV supplementary check — rejects destinations in unwalkable_tiles.csv.
 *
 * This is the ground-truth for "can a bot physically take this step?"
 * It is exposed as a debug helper and used by trimPathAtCsvBlock.
 */
export function canBotStep(level: number, x: number, z: number, nx: number, nz: number): boolean {
    const dx = nx - x;
    const dz = nz - z;
    if (!canTravel(level, x, z, dx, dz, 1, CollisionFlag.PLAYER, CollisionType.NORMAL)) return false;
    if (BotCollisionMap.isCsvBlocked(level, nx, nz)) return false;
    return true;
}

/** Convenience: is a tile blocked by the CSV alone? */
export function isBotTileBlocked(level: number, x: number, z: number): boolean {
    return BotCollisionMap.isCsvBlocked(level, x, z) || isMapBlocked(x, z, level);
}

// ── Path trimming ─────────────────────────────────────────────────────────────

/** Trim compressed rsmod turn points in execution order, including tiles between turns. */
export function trimPathAtCsvBlock(level: number, path: Uint32Array, srcX: number, srcZ: number): Uint32Array {
    if (path.length === 0 || !BotCollisionMap.isLoaded) return path;
    let x = srcX;
    let z = srcZ;
    for (let i = 0; i < path.length; i++) {
        const nx = (path[i] >> 14) & 0x3fff;
        const nz = path[i] & 0x3fff;
        const startX = x;
        const startZ = z;
        while (x !== nx || z !== nz) {
            const tx = x + Math.sign(nx - x);
            const tz = z + Math.sign(nz - z);
            if (BotCollisionMap.isCsvBlocked(level, tx, tz)) {
                const prefix = Array.from(path.slice(0, i));
                if (x !== startX || z !== startZ) prefix.push((level << 28) | (x << 14) | z);
                return Uint32Array.from(prefix);
            }
            x = tx;
            z = tz;
        }
    }
    return path;
}

// ── Destination validation ────────────────────────────────────────────────────

/**
 * Find the nearest tile to (destX, destZ) that is not CSV-blocked and not
 * WALK_BLOCKED according to rsmod.  Searches outward from radius 0 to maxRadius.
 *
 * Returns the original destination if it is already walkable, or the nearest
 * alternative, or null if no walkable tile is found within maxRadius.
 *
 * Does NOT run full pathfinding for each candidate — it only checks static
 * tile flags.  If the found tile is unreachable due to walls, stuck detection
 * in BotMovementMonitor will catch it.
 */
export function findNearestWalkableTile(
    level: number,
    destX: number,
    destZ: number,
    maxRadius: number = 5
): { x: number; z: number } | null {
    // Radius 0: dest itself
    if (!BotCollisionMap.isCsvBlocked(level, destX, destZ) && !isMapBlocked(destX, destZ, level)) {
        return { x: destX, z: destZ };
    }

    for (let r = 1; r <= maxRadius; r++) {
        let best: { x: number; z: number } | null = null;
        let bestDistSq = Infinity;

        for (let dx = -r; dx <= r; dx++) {
            for (let dz = -r; dz <= r; dz++) {
                if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // border of ring only
                const cx = destX + dx;
                const cz = destZ + dz;
                if (BotCollisionMap.isCsvBlocked(level, cx, cz)) continue;
                if (isMapBlocked(cx, cz, level)) continue;
                const dSq = dx * dx + dz * dz;
                if (dSq < bestDistSq) {
                    bestDistSq = dSq;
                    best = { x: cx, z: cz };
                }
            }
        }

        if (best) return best;
    }

    return null;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

/**
 * Explain why a step from (x,z) → (nx,nz) is blocked.
 * Returns a short reason string for logging.
 */
export function explainBlockedStep(level: number, x: number, z: number, nx: number, nz: number): string {
    if (BotCollisionMap.isCsvBlocked(level, nx, nz)) return `csv_blocked(${nx},${nz})`;
    if (isMapBlocked(nx, nz, level)) return `WALK_BLOCKED(${nx},${nz})`;
    const dx = nx - x;
    const dz = nz - z;
    if (!canTravel(level, x, z, dx, dz, 1, CollisionFlag.PLAYER, CollisionType.NORMAL)) return `edge_blocked(${x},${z})->(${nx},${nz})`;
    return 'no_issue';
}

/**
 * Validate a bot path step-by-step, returning a human-readable report string.
 * Useful in debug scenarios to diagnose exactly which step in a generated path is bad.
 */
export function validateBotPath(level: number, srcX: number, srcZ: number, path: Uint32Array): string {
    if (path.length === 0) return 'empty_path';

    let cx = srcX;
    let cz = srcZ;

    for (let i = 0; i < path.length; i++) {
        const nx = (path[i] >> 14) & 0x3fff;
        const nz = path[i] & 0x3fff;
        while (cx !== nx || cz !== nz) {
            const tx = cx + Math.sign(nx - cx);
            const tz = cz + Math.sign(nz - cz);
            const reason = explainBlockedStep(level, cx, cz, tx, tz);
            if (reason !== 'no_issue') return `waypoint${i + 1}:(${cx},${cz})->(${tx},${tz}) ${reason}`;
            cx = tx;
            cz = tz;
        }
    }

    return 'ok';
}

/**
 * Check whether there is any reachable path from src to dest.
 * Requires an exact, collision-safe endpoint — use sparingly, not every tick.
 */
export function canBotTravel(level: number, srcX: number, srcZ: number, destX: number, destZ: number): boolean {
    return findTileRoute(level, srcX, srcZ, destX, destZ) !== null;
}

export { BotMovementMonitor } from '#/engine/bot/BotMovementMonitor.js';
