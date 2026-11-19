/**
 * BotPlayer.ts
 *
 * Wraps a real engine Player with bot AI.
 */

import fs from 'fs';
import { attachBotDialogue, answerBotDialogue } from '#/engine/bot/BotDialogue.js';
import type { BotTutorial } from '#/engine/bot/BotTutorial.js';
import { tickTravel } from '#/engine/bot/BotTravel.js';
import { pendingGnomeGate } from '#/engine/bot/BotObstacles.js';
import path from 'path';
import Player from '#/engine/entity/Player.js';
import InvType from '#/cache/config/InvType.js';
import { BotTask, IdleTask } from '#/engine/bot/tasks/Index.js';
import { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';
import { addXp, getBaseLevel, PlayerStat, openNearbyGate } from '#/engine/bot/BotAction.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import ScriptState from '#/engine/script/ScriptState.js';
import { BotMovementMonitor } from '#/engine/bot/BotMovementMonitor.js';
import { BotRouteRetry } from '#/engine/bot/BotRouteRetry.js';
import { BotLog, BotLogLevel } from '#/engine/bot/BotLog.js';
import { BotDebugService } from '#/engine/bot/debug/BotDebugService.js';

const RESCAN_TICKS = 600;
const SUBTASK_MAX_TICKS = 300;

const NO_INTERRUPT_TASKS = new Set(['ShopTrip', 'Bank', 'Walk', 'Init', 'Idle', 'Prayer']);

// ── Phrase lists loaded from data/bot/bot_phrases.json ───────────────────────
// Falls back to a minimal built-in list if the file is missing.
let IDLE_PHRASES: string[] = ['nice', 'gz', 'good spot', 'banking brb', 'almost there', 'good xp here', 'gg', 'brb'];
let LEVELUP_PHRASES: string[] = ['gz me', 'finally!', 'level up!', 'yes!', 'grind never stops', 'getting there'];

try {
    const raw = fs.readFileSync(path.join('data', 'bot', 'bot_phrases.json'), 'utf8');
    const data = JSON.parse(raw) as { idle?: string[]; levelup?: string[] };
    if (Array.isArray(data.idle) && data.idle.length > 0) IDLE_PHRASES = data.idle;
    if (Array.isArray(data.levelup) && data.levelup.length > 0) LEVELUP_PHRASES = data.levelup;
} catch {
    // File not found or malformed — keep the built-in defaults silently.
}

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}
function chance(p: number): boolean {
    return Math.random() < p;
}

export class BotPlayer {
    readonly player: Player;
    readonly planner: BotGoalPlanner;
    readonly name: string;

    currentTask: BotTask | null = null;
    taskHistory: string[] = [];
    xpGained = 0;
    levelsGained = 0;

    /** Observes addXp only; preset PK profiles and loaded saves are not progression. */
    recordXpGain(internalXp: number, levels: number): void {
        this.xpGained += internalXp / 10;
        this.levelsGained += levels;
    }

    private ticksAlive = 0;
    private rescanTimer = 0;
    private planFailCount = 0;
    /** Counts ticks between universal gate sweeps (fires every 5 ticks). */
    private gateCheckTimer = 0;

    // ── Movement monitoring ───────────────────────────────────────────────────
    readonly movementMonitor = new BotMovementMonitor();
    private readonly mainNavigation = new BotRouteRetry();
    private readonly subNavigation = new BotRouteRetry();
    private tickingTask: BotTask | null = null;

    get activeTask(): BotTask | null { return this.tickingTask ?? this.subTask ?? this.currentTask; }
    get navigation(): BotRouteRetry { return this.activeTask && this.activeTask !== this.currentTask ? this.subNavigation : this.mainNavigation; }
    /** Position at the end of the previous tick (set by engine movement before bot.tick). */
    private lastX = -1;
    private lastZ = -1;
    private lastLevel = -1;
    /** Whether the bot had waypoints queued at the end of the previous tick. */
    private lastHadWaypoints = false;

    // ── Sub-task system (for bury bones, eating, etc.) ───────────────────────
    private subTask: BotTask | null = null;
    private subTaskTicks = 0;
    private subTaskYieldPending = false;
    private readonly subTaskRetryAt = new Map<string, number>();

    // ── Deferred teleport ─────────────────────────────────────────────────────
    // botTeleport() stores the destination here and sets player.delayed for 2
    // ticks so the magic cast animation plays at the SOURCE tile before the
    // position jumps.  Mirrors the real [proc,player_teleport_normal] sequence:
    //   anim(human_castteleport) → p_delay(2) → p_telejump → anim(null)
    private pendingTeleport: { x: number; z: number; level: number } | null = null;

    constructor(player: Player, planner: BotGoalPlanner, private readonly tutorial?: BotTutorial) {
        this.player = player;
        this.planner = planner;
        this.name = player.username;

        // link player → bot (so tasks/BotAction can access this)
        (player as any)._bot = this;
        attachBotDialogue(player);

        BotDebugService.registerBot(this);
    }

    // ── Bot debugger accessors (see engine/bot/debug/) ────────────────────────
    // Structural shape consumed by BotDebugService.DebuggableBot. Read-only,
    // no gameplay effect — purely so the debugger can build snapshots without
    // reaching into private fields via reflection.
    get ticksAliveValue(): number {
        return this.ticksAlive;
    }
    get plannerRescanCountdown(): number {
        return Math.max(0, RESCAN_TICKS - this.rescanTimer);
    }
    get plannerFailCount(): number {
        return this.planFailCount;
    }
    movementMonitorInfo(): { isStuck: boolean; isOscillating: boolean; stuckTicks: number } {
        return {
            isStuck: this.movementMonitor.isStuck(),
            isOscillating: this.movementMonitor.isOscillating(),
            stuckTicks: this.movementMonitor.getStuckTicks()
        };
    }

    // ── Debug-only per-tick observation state ─────────────────────────────────
    private _debugPrevStats: Int32Array | null = null;
    private _debugPrevInvTotal = -1;

    /**
     * Observes real evidence of progress (XP gains, inventory changes) once per
     * tick and feeds it to BotDebugService so the dashboard can tell "an
     * interaction was clicked" apart from "the interaction actually worked" —
     * without every task needing to report this itself. Also closes out
     * stale in-flight actions via a tick-based timeout. No-op when the
     * debugger is disabled; any failure here must never affect the bot.
     */
    private _debugTick(): void {
        if (!BotDebugService.enabled) return;

        const p = this.player;

        BotDebugService.noteTaskChange(this.name, this.currentTask?.name ?? null);
        if (this.currentTask) {
            const state = (this.currentTask as unknown as Record<string, unknown>).state;
            BotDebugService.noteStateChange(this.name, typeof state === 'string' ? state : null);
        } else {
            BotDebugService.noteStateChange(this.name, null);
        }

        if (!this._debugPrevStats || this._debugPrevStats.length !== p.stats.length) {
            this._debugPrevStats = Int32Array.from(p.stats);
        } else {
            for (let stat = 0; stat < p.stats.length; stat++) {
                const cur = p.stats[stat];
                const prev = this._debugPrevStats[stat];
                if (cur > prev) {
                    const gained = (cur - prev) / 10;
                    BotDebugService.noteXpGain(this.name, stat, cur);
                    const statName = PlayerStatNameMap.get(stat) ?? `stat${stat}`;
                    BotDebugService.event(this.name, 'xp', `+${gained} ${statName}`, { stat, gained });
                    BotDebugService.resolveActionSuccess(this.name, `+${gained} ${statName}`);
                    this._debugPrevStats[stat] = cur;
                }
            }
        }

        const inv = p.getInventory(InvType.INV);
        if (inv) {
            let total = 0;
            for (let i = 0; i < inv.capacity; i++) {
                const item = inv.get(i);
                if (item) total += item.count;
            }
            if (this._debugPrevInvTotal === -1) {
                this._debugPrevInvTotal = total;
            } else if (total !== this._debugPrevInvTotal) {
                BotDebugService.event(this.name, 'inventory', `inventory count ${this._debugPrevInvTotal} -> ${total}`);
                BotDebugService.resolveActionSuccess(this.name, 'inventory changed');
                this._debugPrevInvTotal = total;
            }
        }

        BotDebugService.resolveStaleAction(this.name);
    }

    /** Called by botTeleport() to queue a deferred position jump. */
    setPendingTeleport(x: number, z: number, level: number): void {
        this.pendingTeleport = { x, z, level };
    }

    // ── Sub-task API ─────────────────────────────────────────────────────────
    /** Refuse duplicate/replacement requests while a child is running or cooling down. */
    setSubTask(task: BotTask): boolean {
        if (this.subTask?.interrupted) this.deferSubTask(this.subTask, 'subtask interrupted', 200);
        if (this.subTask || this.subTaskYieldPending || this.currentTask?.interrupted || task === this.currentTask || this.ticksAlive < (this.subTaskRetryAt.get(task.name) ?? 0)) return false;
        task.reset();
        this.subTask = task;
        this.subTaskTicks = 0;
        this.subNavigation.reset();
        this.clearSubTaskMovement();
        return true;
    }

    tick(): void {
        try {
            this._tick();
        } finally {
            // Includes subtasks, dialogs, planning failures and deferred teleports.
            this.lastHadWaypoints = this.player.hasWaypoints() && !this.player.delayed && this.pendingTeleport === null;
        }
    }

    private _tick(): void {
        this.ticksAlive++;
        this.player.afkEventReady = false;
        if (this.tutorial?.tick(this.player, this.planner)) return;
        if (this.subTask && this.currentTask?.interrupted) this.deferSubTask(this.subTask, 'parent task interrupted', 200);

        try {
            this._debugTick();
        } catch {
            // debugger failure must never affect bot ticking
        }

        // ── MOVEMENT MONITORING ──────────────────────────────────────────────
        // Compare current position (already updated by engine movement this tick)
        // against the position saved at the end of the previous tick to determine
        // if the bot actually moved.  Only evaluate when the bot was trying to walk
        // (had waypoints at the end of last tick) — avoid false stuck alerts while
        // skilling, banking, or waiting on scripts.
        const curX = this.player.x;
        const curZ = this.player.z;
        const curLevel = this.player.level;
        // Parent activity time must not become a stall while its child has priority.
        if (this.subTask) this.mainNavigation.observe(curX, curZ, curLevel, false, this.ticksAlive);

        if (this.lastX !== -1) {
            const moved = curX !== this.lastX || curZ !== this.lastZ || curLevel !== this.lastLevel;
            const walking = this.lastHadWaypoints && !this.player.delayed && this.pendingTeleport === null && curLevel === this.lastLevel;
            this.navigation.observe(curX, curZ, curLevel, walking, this.ticksAlive);
            this.movementMonitor.update(curX, curZ, walking, moved, curLevel);

            if (walking && this.movementMonitor.isStuck()) {
                this.log(
                    `[Navigation] stuck at (${curX},${curZ},${curLevel}) task=${this.activeTask?.name} — clearing waypoints for repath`, 'warn', 'navigation_stuck'
                );
                this.player.clearWaypoints();
                this.player.clearPendingAction();
                this.movementMonitor.resetStuck();
                this.navigationFailed('stuck');
            } else if (walking && this.movementMonitor.isOscillating()) {
                this.log(
                    `[Navigation] oscillating at (${curX},${curZ},${curLevel}) task=${this.activeTask?.name} — clearing waypoints`, 'warn', 'navigation_oscillation'
                );
                this.player.clearWaypoints();
                this.player.clearPendingAction();
                this.movementMonitor.resetOscillation();
                this.navigationFailed('oscillating');
            }
        }

        this.lastX = curX;
        this.lastZ = curZ;
        this.lastLevel = curLevel;

        // Always refresh appearance
        this.player.buildAppearance(InvType.WORN);

        if (this.ticksAlive === 1) {
            this.log(`Online at (${this.player.x}, ${this.player.z}, ${this.player.level}) slot=${this.player.slot}`);
        }

        // ── DEFERRED TELEPORT ────────────────────────────────────────────────
        // botTeleport() plays the cast animation and sets player.delayed for 2
        // ticks, then stores the destination here.  While delayed we hold the
        // bot idle so the animation visibly plays at the source tile.  Once the
        // engine clears player.delayed we fire teleJump and reset the animation.
        if (this.pendingTeleport !== null) {
            if (this.player.delayed) {
                // Still in the 2-tick cast window — let the animation play.
                return;
            }
            // Delay expired — jump to the destination and clear the cast anim.
            const { x, z, level } = this.pendingTeleport;
            this.pendingTeleport = null;
            this.player.playAnimation(-1, 0); // anim(null) — stops the cast loop
            this.player.teleJump(x, z, level);
            return; // let the task pick up normally next tick
        }

        if (tickTravel(this.player)) return;
        if (pendingGnomeGate(this.player) && answerBotDialogue(this.player, /^OK then\.$/i)) return;

        // Auto-respond to p_countdialog: bots have no client to send resume_p_countdialog,
        // so the script hangs forever. Reply with 99 so the full inventory is processed.
        if (this.player.activeScript?.execution === ScriptState.COUNTDIALOG) {
            this.player.activeScript.lastInt = 99;
            this.player.executeScript(this.player.activeScript, true, true);
            return;
        }

        if (chance(0.003)) this._say(pick(IDLE_PHRASES));

        // ── SUB TASK (HIGH PRIORITY) ─────────────────────────────
        if (this.subTask) {
            const child = this.subTask;
            let ran = false;
            this.tickingTask = child;
            try {
                if (child.interrupted) {
                    this.deferCurrentTask('subtask interrupted');
                } else if (child.isComplete(this.player)) {
                    this.finishSubTask(child);
                } else if (!child.shouldRun(this.player)) {
                    this.deferCurrentTask('subtask requirements unavailable');
                } else if (++this.subTaskTicks > SUBTASK_MAX_TICKS) {
                    this.deferCurrentTask('subtask exceeded active tick budget');
                } else {
                    ran = true;
                    child.tick(this.player);
                }
            } catch (err) {
                console.error(`[Bot:${this.name}] SubTask error:`, err);
                this.deferCurrentTask('subtask error');
            } finally {
                this.tickingTask = null;
                // An interrupted child cannot leave another route queued as it exits.
                if (this.subTask !== child) this.clearSubTaskMovement();
            }
            if (ran) return;
        }

        // Give the parent/planner a turn before accepting any new child name.
        this.subTaskYieldPending = false;

        // ── RESCAN ───────────────────────────────────────────────
        this.rescanTimer++;
        if (this.rescanTimer >= RESCAN_TICKS && !this.navigation.hasRecentTravel(this.ticksAlive)) {
            this.rescanTimer = 0;

            if (this.currentTask && !NO_INTERRUPT_TASKS.has(this.currentTask.name)) {
                const candidate = this.planner.pickTask(this.player);

                if (candidate && candidate.name !== this.currentTask.name && !this.planner.isDeferred(candidate.name, this.player.playtime)) {
                    this.log(`Rescan: ${this.currentTask.name} → ${candidate.name}`);
                    this.currentTask.interrupt();
                    this._switchTask(candidate);
                    this.currentTask.reset();
                    this.planFailCount = 0;
                    return;
                }
            }
        }

        // ── NORMAL TASK LOOP ─────────────────────────────────────

        if (!this.currentTask) {
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (this.currentTask!.isComplete(this.player)) {
            this._recordComplete();
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (this.currentTask!.interrupted) {
            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
        }

        if (!this.currentTask!.shouldRun(this.player)) {
            this.planFailCount++;
            this.log(`${this.currentTask!.name} can't run (fail #${this.planFailCount})`);
            this.deferCurrentTask('requirements unavailable', 100);

            if (this.planFailCount >= 5) {
                this.planFailCount = 0;
                this.rescanTimer = RESCAN_TICKS;
            }

            const next = this._pickTask();
            if (!next) return;
            this._switchTask(next);
            return;
        }

        this.planFailCount = 0;

        const activeTask = this.currentTask;
        if (!activeTask) return;

        // ── UNIVERSAL GATE SWEEP ─────────────────────────────────────────────
        // Every 5 ticks, open any closed door or gate within 10 tiles regardless
        // of which task is running or which state it is in.  This covers the
        // "targeting an NPC behind a fence" case where walkTo is not being called
        // (e.g. a combat bot re-engaging its target every 12 ticks while a gate
        // sits between them unopened).  Skip if the player is already mid-script
        // (delayed) or already has a pending interaction (e.g. attacking an NPC).
        //if (++this.gateCheckTimer >= 5) {
            //this.gateCheckTimer = 0;
            //if (!this.player.delayed && !this.player.hasInteraction()) {
            //    openNearbyGate(this.player, 5);
          //  }
        //}

        this.tickingTask = activeTask;
        try {
            activeTask.tick(this.player);
        } catch (err) {
            console.error(`[Bot:${this.name}] Task error in ${activeTask.name}:`, err);
            this.deferCurrentTask('task error');
        } finally {
            this.tickingTask = null;
            if (this.subTask) this.clearSubTaskMovement();
        }
    }

    onLevelUp(stat: PlayerStat, newLevel: number): void {
        const statName = PlayerStatNameMap.get(stat) ?? `stat${stat}`;
        this.log(`LEVEL UP: ${statName} → ${newLevel}`);

        if (chance(0.6)) {
            this._say(pick(LEVELUP_PHRASES) + ` (${statName.toLowerCase()} ${newLevel})`);
        }

        this.rescanTimer = RESCAN_TICKS;
    }

    snapshot() {
        const p = this.player;

        return {
            name: this.name,
            x: p.x,
            z: p.z,
            level: p.level,
            task: this.currentTask?.name ?? 'idle',
            wc: getBaseLevel(p, PlayerStat.WOODCUTTING),
            fishing: getBaseLevel(p, PlayerStat.FISHING),
            mining: getBaseLevel(p, PlayerStat.MINING),
            attack: getBaseLevel(p, PlayerStat.ATTACK),
            strength: getBaseLevel(p, PlayerStat.STRENGTH),
            defence: getBaseLevel(p, PlayerStat.DEFENCE),
            hitpoints: getBaseLevel(p, PlayerStat.HITPOINTS),
            prayer: getBaseLevel(p, PlayerStat.PRAYER),
            ticksAlive: this.ticksAlive
        };
    }

    log(msg: string, level: BotLogLevel = 'debug', key = 'detail'): void {
        BotLog.event(level, this.name, key, msg);
    }

    navigationFailed(reason: string): void {
        if (this.activeTask?.interrupted) return;
        if (reason !== 'stuck' && reason !== 'oscillating') this.log(`[Navigation] ${reason} at (${this.player.x},${this.player.z},${this.player.level}) task=${this.activeTask?.name} toward ${this.navigation.destinationLabel}`, 'warn', reason);
        if (this.navigation.fail(this.ticksAlive)) this.deferCurrentTask(`navigation: ${reason}`);
    }

    deferCurrentTask(reason: string, ticks = 200): void {
        const active = this.activeTask;
        if (active && active !== this.currentTask) {
            this.deferSubTask(active, reason, ticks);
            return;
        }
        if (this.subTask) this.deferSubTask(this.subTask, 'parent task deferred', ticks);
        if (!this.currentTask) return;
        this.planner.deferTask(this.currentTask.name, this.player.playtime + ticks);
        this.log(`${this.currentTask.name} deferred for ${ticks} ticks: ${reason}`, 'warn', 'task_deferred');
        this.currentTask.interrupt();
        this.player.clearPendingAction();
        this.player.clearWaypoints();
    }

    private deferSubTask(task: BotTask, reason: string, ticks: number): void {
        this.subTaskRetryAt.delete(task.name);
        if (this.subTaskRetryAt.size >= 64) this.subTaskRetryAt.delete(this.subTaskRetryAt.keys().next().value!);
        this.subTaskRetryAt.set(task.name, this.ticksAlive + ticks);
        this.log(`Subtask ${task.name} deferred for ${ticks} ticks: ${reason}; parent=${this.currentTask?.name ?? 'planner'}`, 'warn', 'subtask_deferred');
        this.finishSubTask(task, true);
    }

    private finishSubTask(task: BotTask, interrupted = false): void {
        if (this.subTask !== task) return;
        this.subTask = null;
        this.subTaskYieldPending = true;
        task.reset(); // release task-owned resources/claims before the parent resumes
        if (interrupted) task.interrupt();
        this.subNavigation.reset();
        this.clearSubTaskMovement();
    }

    private clearSubTaskMovement(): void {
        this.player.clearPendingAction();
        this.player.clearWaypoints();
        this.movementMonitor.reset();
        this.lastHadWaypoints = false;
        this.mainNavigation.observe(this.player.x, this.player.z, this.player.level, false, this.ticksAlive);
    }

    private _pickTask(): BotTask | null {
        const picked = this.planner.pickTask(this.player);
        const task = picked && this.planner.isDeferred(picked.name, this.player.playtime) ? new IdleTask(30) : picked;

        if (task) {
            task.reset();
            this.log(`→ ${task.name}`);
        }

        return task;
    }

    /**
     * Switches to a new task. Awards 5 Agility XP whenever the task name
     * actually changes (i.e. a different skill/activity was picked).
     *
     * XP is passed as tenths (the engine's internal format): 50 = 5.0 displayed XP.
     * (Level 2 threshold is 830 internally = 83.0 displayed XP.)
     */
    private _switchTask(next: BotTask): void {
        if (this.currentTask) {
            if (this.currentTask.name !== next.name) {
                addXp(this.player, PlayerStat.AGILITY, 10); // 50 internal = 5.0 XP displayed
            }
            this.currentTask.reset(); // allow outgoing task to clean up (e.g. CombatTask unequips armor)
        }
        this.currentTask = next;
        this.movementMonitor.reset(); // clear stuck/oscillation state between tasks
        this.navigation.reset();
        this.lastHadWaypoints = false;
        this.player.clearPendingAction();
        this.player.clearWaypoints();
    }

    private _recordComplete(): void {
        if (!this.currentTask) return;

        this.log(`✓ ${this.currentTask.name}`);
        this.taskHistory.push(this.currentTask.name);

        if (this.taskHistory.length > 10) {
            this.taskHistory.shift();
        }
    }

    private _say(message: string): void {
        this.player.say(message);
    }
}
