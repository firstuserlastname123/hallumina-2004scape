import VarPlayerType from '#/cache/config/VarPlayerType.js';
import LocType from '#/cache/config/LocType.js';
import Player from '#/engine/entity/Player.js';
import Loc from '#/engine/entity/Loc.js';
import { Interaction } from '#/engine/entity/Interaction.js';
import ServerTriggerType from '#/engine/script/ServerTriggerType.js';
import { MoveSpeed } from '#/engine/entity/MoveSpeed.js';
import World from '#/engine/World.js';
import { canBotStep, findLocApproach } from '#/engine/bot/BotNavigation.js';
import type { BotPlayer } from '#/engine/bot/BotPlayer.js';
import { BotLog } from '#/engine/bot/BotLog.js';

type Crossing = { level: number; underground: boolean };
type Attempt = { loc: Loc; op: 1 | 2 | 3 | 4 | 5; type: number; angle: number; shape: number; tick: number; owner: unknown;
    sourceX: number; sourceZ: number; lastX: number; lastZ: number; progressTick: number; femiHelp?: number; crossing?: Crossing };
type State = { pending?: Attempt; failed: Map<string, number> };
const states = new WeakMap<Player, State>();
const WAIT_TICKS = 25;
const RETRY_TICKS = 200;
function state(player: Player): State {
    let value = states.get(player);
    if (!value) { value = { failed: new Map() }; states.set(player, value); }
    return value;
}
function key(loc: Loc, type = loc.type, angle = loc.angle, shape = loc.shape): string {
    return `${loc.level}:${loc.x}:${loc.z}:${type}:${angle}:${shape}`;
}
function remember(s: State, id: string): void {
    for (const [id, until] of s.failed) if (until <= World.currentTick) s.failed.delete(id);
    if (s.failed.size >= 64) s.failed.delete(s.failed.keys().next().value!);
    s.failed.set(id, World.currentTick + RETRY_TICKS);
}
export function isObstacleSuppressed(player: Player, loc: Loc): boolean {
    return (states.get(player)?.failed.get(key(loc)) ?? 0) > World.currentTick;
}
export function pendingGnomeGate(player: Player): boolean {
    const loc = states.get(player)?.pending?.loc;
    return !!loc && LocType.get(loc.type).debugname === 'gnome_areagate';
}
export function hasPendingObstacle(player: Player): boolean { return !!states.get(player)?.pending; }

/** Return true while a real click is unresolved, or on its failure tick. */
export function pollObstacle(player: Player): boolean {
    const s = states.get(player);
    const a = s?.pending;
    if (!s || !a) return false;
    const bot = (player as Player & { _bot?: BotPlayer })._bot;
    if (bot?.activeTask !== a.owner || bot?.activeTask?.interrupted) {
        if (player.target === a.loc) { player.clearPendingAction(); player.clearWaypoints(); }
        s.pending = undefined;
        return false;
    }
    const changed = !a.loc.isValid() || a.loc.type !== a.type || a.loc.angle !== a.angle || a.loc.shape !== a.shape;
    const dx = [-1, 0, 1, 0][a.angle];
    const dz = [0, 1, 0, -1][a.angle];
    const crossed = dx ? Math.sign(player.x - a.loc.x - dx / 2) !== Math.sign(a.sourceX - a.loc.x - dx / 2) :
        Math.sign(player.z - a.loc.z - dz / 2) !== Math.sign(a.sourceZ - a.loc.z - dz / 2);
    const rectangleCrossed = a.shape >= 9 && Math.max(Math.abs(player.x-a.sourceX),Math.abs(player.z-a.sourceZ)) >= 2 &&
        (a.loc.width >= a.loc.length ? Math.sign(player.z-a.loc.z-(a.loc.length-1)/2) !== Math.sign(a.sourceZ-a.loc.z-(a.loc.length-1)/2) :
            Math.sign(player.x-a.loc.x-(a.loc.width-1)/2) !== Math.sign(a.sourceX-a.loc.x-(a.loc.width-1)/2));
    const complete = a.crossing ? player.level === a.crossing.level && (player.z > 4100) === a.crossing.underground :
        changed && (crossed || rectangleCrossed || canBotStep(a.loc.level, a.loc.x, a.loc.z, a.loc.x + dx, a.loc.z + dz));
    if (complete && !player.delayed && !player.activeScript) {
        s.pending = undefined;
        BotLog.event('debug', player.username, a.crossing ? 'transition_completed' : 'gate_opened', `Obstacle passed at (${a.loc.x},${a.loc.z},${a.loc.level})`);
        return false;
    }
    // The gate's first native dialogue may finish Femi's prerequisite instead
    // of opening it. Observe that exact native result and permit a fresh click.
    if (a.femiHelp !== undefined && player.vars[VarPlayerType.getId('femi_help')] > a.femiHelp &&
        !player.delayed && !player.activeScript) {
        s.pending = undefined;
        BotLog.event('debug', player.username, 'obstacle_prerequisite', 'Native Femi dialogue completed; retry gate');
        return false;
    }
    if ((player.x !== a.lastX || player.z !== a.lastZ) && player.target === a.loc) a.progressTick = World.currentTick;
    a.lastX = player.x; a.lastZ = player.z;
    // Native queues retain the tail on overflow. Continue a safe prefix from
    // the actual position rather than dropping early turns in a long approach.
    if (!player.delayed && !player.activeScript && !player.hasWaypoints() &&
        (!player.hasInteraction() || player.target === a.loc) && a.loc.isValid() && !player.inOperableDistance(a.loc)) {
        const approach = findLocApproach(player, a.loc);
        if (approach?.path.length) {
            if (!player.hasInteraction()) player.setInteraction(Interaction.ENGINE, a.loc, ServerTriggerType.APLOC1 + a.op - 1);
            player.queueWaypoints(approach.path.slice(0, player.waypoints.length));
        }
    }
    // Approaching a legal face can take longer than the opening itself. Only
    // observed movement extends the idle budget; a click is not progress.
    if (World.currentTick - a.tick < 200 &&
        (player.delayed || player.activeScript || World.currentTick - a.progressTick < WAIT_TICKS)) return true;
    remember(s, key(a.loc, a.type, a.angle, a.shape));
    s.pending = undefined;
    if (player.target === a.loc) { player.clearPendingAction(); player.clearWaypoints(); }
    if (bot) bot.navigationFailed('obstacle_failed');
    else BotLog.event('warn', player.username, 'obstacle_failed', `Obstacle did not permit passage at (${a.loc.x},${a.loc.z},${a.loc.level}); retry after ${RETRY_TICKS} ticks`);
    return true;
}

/** One normal engine click; never dispatch RuneScript directly or assume success. */
export function tryObstacle(player: Player, loc: Loc, op: 1 | 2 | 3 | 4 | 5, crossing?: Crossing): boolean {
    if (pollObstacle(player)) return true;
    if ((player as Player & { _bot?: BotPlayer })._bot?.activeTask?.interrupted) return false;
    if (isObstacleSuppressed(player, loc) || !player.canAccess()) return false;
    const s = state(player);
    const approach = findLocApproach(player, loc);
    if (!approach) { remember(s, key(loc)); return false; }
    player.clearPendingAction();
    player.clearWaypoints();
    player.moveSpeed = MoveSpeed.WALK;
    if (!player.setInteraction(Interaction.ENGINE, loc, ServerTriggerType.APLOC1 + op - 1)) return false;
    if (approach.path.length) player.queueWaypoints(approach.path.slice(0, player.waypoints.length));
    s.pending = { loc, op, type: loc.type, angle: loc.angle, shape: loc.shape, tick: World.currentTick,
        // A legitimate approach can circle to the opposite face. Verify passage
        // from that operating position, rather than the side where we clicked.
        sourceX: approach.x, sourceZ: approach.z,
        lastX: player.x, lastZ: player.z, progressTick: World.currentTick,
        femiHelp: LocType.get(loc.type).debugname === 'gnome_areagate' ? player.vars[VarPlayerType.getId('femi_help')] : undefined,
        owner: (player as Player & { _bot?: BotPlayer })._bot?.activeTask, crossing };
    BotLog.event('debug', player.username, crossing ? 'transition_attempt' : 'gate_attempt', `Interact op${op} at (${loc.x},${loc.z},${loc.level})`);
    return true;
}
