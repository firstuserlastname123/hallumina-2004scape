import { BotTask, Player, walkTo, hasItem, isNear } from '#/engine/bot/tasks/BotTaskBase.js';
import { findObjNear, interactObjOp } from '#/engine/bot/BotAction.js';
import { findTileRoute, botPathCost } from '#/engine/bot/BotNavigation.js';
import { chooseTravel, onTutorialIsland } from '#/engine/bot/BotTravel.js';

export interface SpawnEntry {
    coords: [number, number, number];
    /** Optional intermediate waypoint to route around obstacles before the final coords. */
    via?: [number, number, number];
}

/** Retrieve a real floor item, holding one destination and consuming its via once. */
export class PickupSpawnTask extends BotTask {
    private readonly itemId: number;
    private readonly spawns: SpawnEntry[];
    private target: SpawnEntry | null = null;
    private viaDone = false;
    private state: 'walk' | 'find' | 'pickup' | 'done' = 'walk';
    private waitTicks = 0;
    private lastFailures = 0;
    private readonly unavailable = new Map<SpawnEntry, number>();

    constructor(itemId: number, spawns: SpawnEntry[]) {
        super('PickupSpawn');
        this.itemId = itemId;
        this.spawns = spawns;
    }

    shouldRun(player: Player): boolean {
        return !hasItem(player, this.itemId) && this.state !== 'done';
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) { this.cooldown--; return; }
        if (hasItem(player, this.itemId)) { this.state = 'done'; return; }
        const bot = (player as any)._bot;
        const failures = bot?.navigation.failures ?? 0;
        if (this.state === 'walk' && failures >= 2 && failures > this.lastFailures) this.exclude(player);
        this.lastFailures = failures;
        if (!this.target) {
            this.target = this.nearestSpawn(player);
            this.viaDone = false;
            if (!this.target) {
                bot?.deferCurrentTask('no reachable available ground-item spawn');
                this.interrupt();
                return;
            }
        }
        const [tx, tz, tl] = this.target.coords;
        if (this.state === 'walk') {
            if (this.target.via && !this.viaDone && !isNear(player, tx, tz, 5, tl)) {
                const [vx, vz, vl] = this.target.via;
                // A live local route supersedes a historical castle bypass.
                if (isNear(player, vx, vz, 5, vl) || (player.level === tl && findTileRoute(tl, player.x, player.z, tx, tz))) this.viaDone = true;
                else { walkTo(player, vx, vz, vl); return; }
            }
            if (!isNear(player, tx, tz, 5, tl)) { walkTo(player, tx, tz, tl); return; }
            this.state = 'find';
            this.waitTicks = 0;
            return;
        }
        if (this.state === 'find') {
            const obj = findObjNear(player, tx, tz, tl, this.itemId, 5);
            if (obj) {
                interactObjOp(player, obj, 3);
                this.state = 'pickup';
                this.waitTicks = 0;
            } else if (++this.waitTicks > 60) this.exclude(player);
            return;
        }
        if (this.state === 'pickup') {
            // Keep the native pickup running until its bounded outcome is known.
            if (++this.waitTicks > 10) this.exclude(player);
        }
    }

    isComplete(player: Player): boolean { return this.state === 'done' || hasItem(player, this.itemId); }

    override reset(): void {
        super.reset();
        this.state = 'walk';
        this.target = null;
        this.viaDone = false;
        this.waitTicks = this.lastFailures = 0;
        this.unavailable.clear();
    }

    private exclude(player: Player): void {
        if (this.target) this.unavailable.set(this.target, player.playtime + 200);
        this.target = null;
        this.state = 'walk';
        this.waitTicks = 0;
        player.clearPendingAction();
        player.clearWaypoints();
    }

    private nearestSpawn(player: Player): SpawnEntry | null {
        let best: SpawnEntry | null = null;
        let cost = Infinity;
        for (const spawn of this.spawns) {
            if ((this.unavailable.get(spawn) ?? 0) > player.playtime) continue;
            const [x, z, level] = spawn.coords;
            if (onTutorialIsland(player.x, player.z) !== onTutorialIsland(x, z)) continue;
            if (!['land', 'ship', 'tunnel'].includes(chooseTravel(player, x, z).mode)) continue;
            const distance = Math.max(Math.abs(player.x - x), Math.abs(player.z - z));
            let steps = distance + (player.level === level ? 0 : 100);
            if (player.level === level && distance <= 60) {
                const route = findTileRoute(level, player.x, player.z, x, z);
                if (!route) continue;
                steps = botPathCost(player.x, player.z, route.path);
            }
            if (steps < cost) { best = spawn; cost = steps; }
        }
        return best;
    }
}
