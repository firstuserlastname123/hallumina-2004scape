/**
 * WoodcuttingTask.ts
 *
 * Chops trees using real engine loc interactions (APLOC1 = Chop down).
 * Progression: normal trees (level 1) → oaks (15) → willows (30) → yews (60).
 * Sells logs at Lumbridge General Store for coins to fund axe upgrades.
 *
 * Key behaviours:
 *   - PRE-WALKS adjacent to the tree before calling interactLoc().
 *     The engine clears interaction silently if the bot is not operable distance,
 *     so we must be touching the tree face before triggering it.
 *   - Excludes stumps ('treestump'.startsWith('tree') = true — no op1 script).
 *   - StuckDetector catches oscillation as well as stationary stuck.
 *   - Opens nearby fence gates automatically when stuck.
 *   - Level-up upgrades step and re-walks to new area.
 */

import { findReachableLoc } from '#/engine/bot/BotAction.js';
import { BotLog } from '#/engine/bot/BotLog.js';
import { findLocApproach } from '#/engine/bot/BotNavigation.js';
import LocType from '#/cache/config/LocType.js';
import {
    BotTask, Player, Loc, InvType,
    walkTo, interactLoc,
    claimLoc, releaseLoc, isLocClaimed,
    hasItem, addItem, isInventoryFull, isNear,
    getBaseLevel, PlayerStat,
    Items, Locations, getProgressionStep,
    randInt, bankInvId, INTERACT_TIMEOUT, StuckDetector, ProgressWatchdog,
    isAdjacentToLoc, botJitter, advanceBankWalk, hasStrayItems,
} from '#/engine/bot/tasks/BotTaskBase.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import { getCombatLevel, getNpcCombatLevel, findAggressorNpc } from '#/engine/bot/BotAction.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';

/** Draynor village woodcutting spots — aggressive Dark Wizards patrol here, minimum combat 15. */
const DRAYNOR_WC_LOCATIONS: Array<[number, number, number]> = [
    Locations.WILLOWS_DRAYNOR,
];

export class WoodcuttingTask extends BotTask {
    private step: SkillStep;

    /**
     * State machine:
     *   walk      → walking to tree area
     *   approach  → found a tree, walking adjacent to it
     *   interact  → adjacent, interaction queued, waiting for XP
     *   bank_walk → walking to sell logs
     *   bank_done → logs sold, return to walk
     */
    private state: 'walk' | 'approach' | 'interact' | 'flee' | 'bank_walk' | 'bank_done' = 'walk';
    private interactTicks  = 0;
    private lastXp         = 0;
    private scanFailTicks  = 0;
    private approachTicks  = 0;   // ticks spent approaching a tree
    private fleeTicks      = 0;
    private readonly FLEE_TICKS = 12;
    private readonly unavailableTrees = new Map<Loc, number>();
    private currentTree:  Loc | null = null;
    private readonly stuck    = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog();

    constructor(step: SkillStep) {
        // Include the log type so the rescan name-comparison in BotPlayer
        // can distinguish "cut trees for LOGS" from "cut willows for WILLOW_LOGS"
        // and force a task switch when the planner needs a different log type.
        super(`Woodcut:${step.itemGained}`);
        this.step = step;
        this.watchdog.destination = step.location;
    }

    shouldRun(player: Player): boolean {
        const hasHatchetInv  = this.step.toolItemIds.some(id => hasItem(player, id));
        const hasHatchetBank = !hasHatchetInv && this._hatchetInBank(player);
        if (!hasHatchetInv && !hasHatchetBank) return false;

        // Draynor village has aggressive Dark Wizards — require combat level 15
        const [sx, sz, sl] = this.step.location;
        const isDraynor = DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
        if (isDraynor && getCombatLevel(player) < 15) return false;

        return true;
    }

    private _hatchetInBank(player: Player): boolean {
        const bid = bankInvId();
        if (bid === -1) return false;
        const bank = player.getInventory(bid);
        if (!bank) return false;
        for (let i = 0; i < bank.capacity; i++) {
            if (this.step.toolItemIds.includes(bank.get(i)?.id ?? -1)) return true;
        }
        return false;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        const bot = (player as any)._bot;
        if (bot && !bot.navigation.canAttempt(bot.ticksAliveValue)) return;
        const banking = this.state === 'bank_walk' || this.state === 'bank_done';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this.stuck.reset();
            this.state = 'approach';
            this._releaseTree();
            this.interactTicks = 0;
            this.scanFailTicks = 0;
            this.approachTicks = 0;
            this.cooldown = 3;
            return;
        }
        if (this.cooldown > 0) { this.cooldown--; return; }

        // ── Hatchet recovery ─────────────────────────────────────────────────
        // If the hatchet was banked by another task, go retrieve it before chopping.
        if (!this.step.toolItemIds.some(id => hasItem(player, id)) && this._hatchetInBank(player)) {
            this.state = 'bank_walk';
        }

        // ── Aggressor detection ───────────────────────────────────────────────
        if (this.state !== 'bank_walk' && this.state !== 'bank_done' && this.state !== 'flee') {
            const aggressor = findAggressorNpc(player, 8);
            if (aggressor) {
                const npcLvl = getNpcCombatLevel(aggressor);
                if (npcLvl > player.combatLevel) {
                    this.state = 'flee';
                    this.fleeTicks = 0;
                    this._releaseTree();
                    return;
                }
            }
        }

        // Upgrade step when level-up unlocks a better tree tier.
        // Skip Draynor steps for low-combat bots — Dark Wizards are aggressive there.
        const level   = getBaseLevel(player, PlayerStat.WOODCUTTING);
        const newStep = getProgressionStep('WOODCUTTING', level);
        if (newStep && newStep.minLevel > this.step.minLevel) {
            const [sx, sz, sl] = newStep.location;
            const isNewDraynor = DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
            if (!isNewDraynor || getCombatLevel(player) >= 15) {
                this.step         = newStep;
                this.state        = 'walk';
                this._releaseTree();
            }
        }

        // ── Bank logs ─────────────────────────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck);
            if (result === 'walk') return;
            // 'ready' = interaction queued; 'direct' = deposit without UI
            this.cooldown = result === 'ready' ? 3 : 0;
            this.state = 'bank_done';
            return;
        }

        if (this.state === 'bank_done') {
            this._depositLoot(player);
            this._rerollStep(player); // re-randomise tree location for the next run
            this.state = 'walk'; this.cooldown = 3; return;
        }

        if (isInventoryFull(player)) { this.state = 'bank_walk'; return; }

        // Carrying leftovers from a previous task (e.g. ore, loot) — bank them
        // before heading out to the tree so the trip starts with a clean slate.
        if (this.state === 'walk' && hasStrayItems(player, [...this.step.toolItemIds, Items.COINS, Items.KNIFE, Items.TINDERBOX])) {
            this.state = 'bank_walk';
            return;
        }

        // ── Flee ──────────────────────────────────────────────────────────────
        if (this.state === 'flee') {
            this.fleeTicks++;
            const [lx, lz] = this.step.location;
            this._stuckWalk(player, lx, lz);
            if (this.fleeTicks >= this.FLEE_TICKS || isNear(player, lx, lz, 12)) {
                this.state = 'walk';
                this.fleeTicks = 0;
            }
            return;
        }

        // ── Walk to tree area ─────────────────────────────────────────────────
        if (this.state === 'walk') {
            const [lx, lz, ll] = this.step.location;
            if (!isNear(player, lx, lz, 15, ll)) {
                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village willows).  Only apply when the bot hasn't yet passed it —
                // check player.z so a bot already north of the waypoint skips it.
                const via = this.step.via;
                if (via && player.level === via[2] && player.z < via[1] && !isNear(player, via[0], via[1], 5)) {
                    const [jx, jz] = botJitter(player, via[0], via[1], 3);
                    this._stuckWalk(player, jx, jz);
                    return;
                }
                const [jx, jz] = botJitter(player, lx, lz, 5);
                this._stuckWalk(player, jx, jz);
                return;
            }
            this.state = 'approach'; // arrived — now find and approach a tree
            return;
        }

        // ── Find tree and walk adjacent ───────────────────────────────────────
        if (this.state === 'approach') {
            // If we just became full, bank first
            if (isInventoryFull(player)) { this.state = 'bank_walk'; return; }

            // Drop stale reference if another player felled the tree
            if (this.currentTree && !this._isTreeStillValid(this.currentTree)) {
                this._releaseTree();
                this.approachTicks = 0;
            }

            const tree = this.currentTree ?? this._findTree(player);
            if (!tree) {
                this.scanFailTicks++;
                if (this.scanFailTicks === 1) {
                    BotLog.debug(`[WC:${player.username}] No '${this._treePrefix()}' tree near (${player.x},${player.z})`);
                }
                if (this.scanFailTicks > 10) {
                    // Wander within tree area and try again
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                    this.scanFailTicks = 0;
                }
                return;
            }
            this.scanFailTicks = 0;
            this.currentTree   = tree;
            claimLoc(tree);

            if (isAdjacentToLoc(player, tree)) {
                // Already adjacent — interact immediately
                BotLog.debug(`[WC:${player.username}] Adjacent to '${this._treePrefix()}' at (${tree.x},${tree.z}), interacting`);
                interactLoc(player, tree);
                this.state         = 'interact';
                this.interactTicks = 0;
                this.lastXp        = player.stats[PlayerStat.WOODCUTTING];
                this.approachTicks = 0;
            } else {
                // Walk to the tile directly adjacent to the tree's nearest face
                const tile = this._approachTile(player, tree);
                if (!tile) {
                    this._excludeTree(player, tree);
                    this._releaseTree();
                    this.approachTicks = 0;
                    (player as any)._bot?.navigationFailed('resource_unreachable');
                    return;
                }
                walkTo(player, tile[0], tile[1], tree.level);
                this.approachTicks++;
                if (this.approachTicks > 30) {
                    // Can't reach this tree — try another
                    BotLog.debug(`[WC:${player.username}] Can't reach tree at (${tree.x},${tree.z}), retrying`);
                    this._excludeTree(player, tree);
                    this._releaseTree();
                    this.approachTicks = 0;
                    const [lx, lz] = this.step.location;
                    walkTo(player, lx + randInt(-5, 5), lz + randInt(-5, 5));
                }
            }
            return;
        }

        // ── Chopping ──────────────────────────────────────────────────────────
        if (this.state === 'interact') {
            // Tree was felled mid-chop by another player — rescan immediately
            if (this.currentTree && !this._isTreeStillValid(this.currentTree)) {
                this.state        = 'approach';
                this._releaseTree();
                this.interactTicks = 0;
                return;
            }
            this.interactTicks++;

            if (player.stats[PlayerStat.WOODCUTTING] > this.lastXp) {
                BotLog.debug(`[WC:${player.username}] XP gained! total=${player.stats[PlayerStat.WOODCUTTING]}`);
                this.lastXp        = player.stats[PlayerStat.WOODCUTTING];
                this.interactTicks = 0;
                this.watchdog.notifyActivity();
                if (this.currentTree) interactLoc(player, this.currentTree);
                return;
            }

            if (this.interactTicks >= INTERACT_TIMEOUT) {
                // Tree depleted or interaction was cleared — find another
                BotLog.debug(`[WC:${player.username}] Interact timeout, rescanning`);
                this.state        = 'approach';
                this._releaseTree();
                this.interactTicks = 0;
            }
        }
    }

    isComplete(_p: Player): boolean { return false; }

    override getDebugInfo(_player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        return {
            task: this.name,
            state: this.state,
            target: this.currentTree ? `${LocType.get(this.currentTree.type).debugname ?? 'tree'}@(${this.currentTree.x},${this.currentTree.z})` : undefined,
            destination: { x: lx, z: lz, level: ll },
            details: {
                itemGained: this.step.itemGained,
                interactTicks: this.interactTicks,
                scanFailTicks: this.scanFailTicks,
                approachTicks: this.approachTicks,
                fleeTicks: this.fleeTicks,
                stuck: this.stuck.getDebugSnapshot()
            }
        };
    }

    override reset(): void {
        super.reset();
        this.state         = 'walk';
        this.interactTicks = 0;
        this.scanFailTicks = 0;
        this.approachTicks = 0;
        this.lastXp        = 0;
        this.fleeTicks     = 0;
        this._releaseTree();
        this.stuck.reset();
        this.watchdog.reset();
    }

    // ── Tree search ───────────────────────────────────────────────────────────

    private _findTree(player: Player): Loc | null {
        // 'treestump'.startsWith('tree') = true — must exclude stumps.
        // Stumps have no [oploc1] script so the woodcutting script silently fails.
        // Prefer a tree nobody else is on, so nearby bots spread across the
        // grove instead of all converging on the single nearest tree
        // (findLocByPrefix alone always returns the exact same closest match
        // for bots standing in roughly the same spot). But if every tree in
        // range is already claimed, fall back to the closest one regardless —
        // better to share a tree than to sit scanning forever finding nothing.
        return findReachableLoc(player, 15, loc => {
            const name = LocType.get(loc.type).debugname ?? '';
            return name.startsWith(this._treePrefix()) && !name.includes('stump') &&
                (this.unavailableTrees.get(loc) ?? 0) <= player.playtime;
        }, loc => isLocClaimed(loc) ? 20 : 0);
    }

    private _excludeTree(player: Player, tree: Loc): void {
        for (const [loc, until] of this.unavailableTrees) if (until <= player.playtime) this.unavailableTrees.delete(loc);
        if (this.unavailableTrees.size >= 64) this.unavailableTrees.delete(this.unavailableTrees.keys().next().value!);
        this.unavailableTrees.set(tree, player.playtime + 200);
    }

    /** Release the currently claimed tree (if any) so other bots can target it. */
    private _releaseTree(): void {
        releaseLoc(this.currentTree);
        this.currentTree = null;
    }

    /**
     * Returns false if the stored tree reference has been replaced by a stump
     * (another player felled it while this bot was approaching or chopping).
     */
    private _isTreeStillValid(tree: Loc): boolean {
        const name = LocType.get(tree.type).debugname ?? '';
        return tree.isValid() && name.startsWith(this._treePrefix()) && !name.includes('stump');
    }

    private _treePrefix(): string {
        switch (this.step.itemGained) {
            case Items.OAK_LOGS:    return 'oaktree';
            case Items.WILLOW_LOGS: return 'willowtree';
            case Items.MAPLE_LOGS:  return 'mapletree';
            case Items.YEW_LOGS:    return 'yewtree';
            case Items.MAGIC_LOGS:  return 'magictree';
            default:                return 'tree';
        }
    }

    /** Use the engine's dimensions, rotation, collision and operating rules. */
    private _approachTile(player: Player, tree: Loc): [number, number] | null {
        const tile = findLocApproach(player, tree);
        return tile ? [tile.x, tile.z] : null;
    }

    // ── Step re-roll ─────────────────────────────────────────────────────────

    /** Pick a fresh random step matching the bot's current level and owned tools. */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, PlayerStat.WOODCUTTING);
        const combatLvl = getCombatLevel(player);
        const newStep = getProgressionStep(
            'WOODCUTTING', level,
            ids => ids.some(id => hasItem(player, id)),
        );
        if (newStep) {
            const [sx, sz, sl] = newStep.location;
            const isDraynor = DRAYNOR_WC_LOCATIONS.some(([lx, lz, ll]) => lx === sx && lz === sz && ll === sl);
            if (!isDraynor || combatLvl >= 15) {
                this.step = newStep;
                this._releaseTree();
            }
        }
    }

    private _depositLoot(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bid = bankInvId();
        if (!inv || bid === -1) return;
        const bank = player.getInventory(bid);
        if (!bank) return;
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (this.step.toolItemIds.includes(item.id)) continue;
            if (item.id === Items.COINS) continue;
            if (item.id === Items.KNIFE) continue;
            if (item.id === Items.TINDERBOX) continue;
            const moved = inv.remove(item.id, item.count);
            if (moved.completed > 0) bank.add(item.id, moved.completed);
        }
        // Withdraw hatchet if it was banked by another task (e.g. FletchingTask)
        if (!this.step.toolItemIds.some(id => hasItem(player, id))) {
            for (const id of this.step.toolItemIds) {
                const removed = bank.remove(id, 1);
                if (removed.completed > 0) {
                    addItem(player, id, 1);
                    break;
                }
            }
        }
        BotLog.debug(`[WC:${player.username}] Deposited logs into the bank.`);
    }


    // ── Stuck walk with gate opener ───────────────────────────────────────────

    private _stuckWalk(player: Player, lx: number, lz: number): void {
        if (!this.stuck.check(player, lx, lz)) {
            walkTo(player, lx, lz);
            return;
        }
        if (this.stuck.desperatelyStuck) {
            (player as any)._bot?.deferCurrentTask('woodcutting destination inaccessible');
            this.interrupt();
            this.stuck.reset();
            return;
        }
        walkTo(player, lx, lz);
    }
}
