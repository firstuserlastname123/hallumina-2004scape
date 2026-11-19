import type Obj from '#/engine/entity/Obj.js';
import Component from '#/cache/config/Component.js';
import { getWorld } from '#/engine/bot/BotWorld.js';
import { pollObstacle } from '#/engine/bot/BotObstacles.js';
import { findPathToEntity, reachedEntity } from '#/engine/GameMap.js';
import { validateBotPath } from '#/engine/bot/BotNavigation.js';
import {
    BotTask,
    Player,
    Npc,
    InvType,
    walkTo,
    interactNpcOp,
    findNpcByName,
    hasItem,
    isInventoryFull,
    isNear,
    getBaseLevel,
    PlayerStat,
    Items,
    Locations,
    getProgressionStep,
    nearestBank,
    randInt,
    bankInvId,
    INTERACT_TIMEOUT,
    StuckDetector,
    ProgressWatchdog,
    botJitter,
    advanceBankWalk,
    FOOD_IDS
} from '#/engine/bot/tasks/BotTaskBase.js';
import type { SkillStep } from '#/engine/bot/tasks/BotTaskBase.js';
import {
    findLootObj,
    interactHeldOp,
    openGateToward,
    interactIfButtonByName,
    npcMatchesName,
    getNpcCombatLevel,
    findAggressorNpc,
    interactIF_UseOp,
    interactObjOp,
    _equipLoot,
    countItem
} from '#/engine/bot/BotAction.js';
import NpcType from '#/cache/config/NpcType.js';
import { Interfaces, GRIMY_HERB_MAP, SkillProgression } from '#/engine/bot/BotKnowledge.js';
import { hasAllTools, hasStepTool } from '#/engine/bot/BotNeeds.js';
import { CoordGrid } from '#/engine/CoordGrid.js';
import { NpcStat } from '#/engine/entity/NpcStat.js';
import ScriptState from '#/engine/script/ScriptState.js';
import type { BotTaskDebugInfo } from '#/engine/bot/debug/BotDebugTypes.js';
import { PlayerStatNameMap } from '#/engine/entity/PlayerStat.js';
import { BotLog } from '#/engine/bot/BotLog.js';

// ── Shared NPC claim registry ─────────────────────────────────────────────────
// Module-level set of NPC keys currently targeted by any CombatTask instance.
// Bots skip NPCs in this set so they don't pile onto the same target.
const CLAIMED_NPCS = new Set<number>();

type CombatExtra = {
    npcType?: string;
    npcTypes?: string[];
    npcName?: string;
    npcPrefix?: string;
    npcSuffix?: string;
};

// Melee style rotation: accurate(0)→attack, aggressive(1)→strength, defensive(3)→defence
const TRAIN_CYCLE: Array<{ stat: PlayerStat; style: 0 | 1 | 3 }> = [
    { stat: PlayerStat.ATTACK, style: 0 },
    { stat: PlayerStat.STRENGTH, style: 1 },
    { stat: PlayerStat.DEFENCE, style: 3 }
];

const STYLE_BUTTONS: Record<string, string> = { combat_unarmed: 'unarmed', combat_hacksword: 'hack', combat_stabsword: 'stab',
    combat_axe: 'axe', combat_heavysword: 'heavy', combat_pickaxe: 'pickaxe', combat_blunt: 'blunt',
    combat_spiked: 'spiked', combat_spear: 'spear', combat_scythe: 'scythe', combat_claw: 'claw' };

// Worn slots that are considered armor (helm, torso, shield, legs). Does not include weapon (3) or ammo (13).
const ARMOR_WORN_SLOTS = new Set([0, 4, 5, 7]);

// Scimitar tiers ordered best-first; the first entry whose minAtk ≤ player's Attack level is used.
const SCIMITAR_TIERS: Array<{ minAtk: number; itemId: number }> = [
    { minAtk: 40, itemId: Items.RUNE_SCIMITAR    },
    { minAtk: 30, itemId: Items.ADAMANT_SCIMITAR },
    { minAtk: 20, itemId: Items.MITHRIL_SCIMITAR },
    { minAtk: 10, itemId: Items.BLACK_SCIMITAR   },
    { minAtk: 5,  itemId: Items.STEEL_SCIMITAR   },
    { minAtk: 1,  itemId: Items.IRON_SCIMITAR    },
];

// Sharks to maintain in inventory during combat.
const COMBAT_SHARKS = 15;

// Armor sets ordered best-first; the first entry whose minDef ≤ player's Defence level is used.
const ARMOR_SETS: Array<{ minDef: number; pieces: number[] }> = [
    { minDef: 40, pieces: [Items.RUNE_FULL_HELM,    Items.RUNE_PLATEBODY,    Items.RUNE_PLATELEGS,    Items.RUNE_KITESHIELD    ] },
    { minDef: 30, pieces: [Items.ADAMANT_FULL_HELM,  Items.ADAMANT_PLATEBODY,  Items.ADAMANT_PLATELEGS,  Items.ADAMANT_KITESHIELD  ] },
    { minDef: 20, pieces: [Items.MITHRIL_FULL_HELM,  Items.MITHRIL_PLATEBODY,  Items.MITHRIL_PLATELEGS,  Items.MITHRIL_KITESHIELD  ] },
    { minDef: 10, pieces: [Items.BLACK_FULL_HELM,    Items.BLACK_PLATEBODY,    Items.BLACK_PLATELEGS,    Items.BLACK_KITESHIELD    ] },
    { minDef: 5,  pieces: [Items.STEEL_FULL_HELM,    Items.STEEL_PLATEBODY,    Items.STEEL_PLATELEGS,    Items.STEEL_KITESHIELD    ] },
    { minDef: 1,  pieces: [Items.IRON_FULL_HELM,     Items.IRON_PLATEBODY,     Items.IRON_PLATELEGS,     Items.IRON_KITESHIELD     ] },
];

export class CombatTask extends BotTask {
    private step: SkillStep;
    private readonly primaryStat: PlayerStat; // governs location/progression
    private stat: PlayerStat; // current training stat (rotates per kill)
    private trainIndex = 0;
    private readonly noAttackTimeoutTicks = 12; // RS2 rounds are 5-6 ticks; allow ~2 full rounds before timeout

    private state: 'walk' | 'scan' | 'interact' | 'flee' | 'shop_walk' | 'shop_open' | 'shop_sell' | 'bank_walk' | 'bank_deposit' | 'loot' | 'bury' | 'eat' = 'walk';

    private interactTicks = 0;
    private approachTicks = 0;
    private lastXp = 0;
    private scanFail = 0;
    private blockedCandidate: Npc | null = null;
    private triedSaferArea = false;
    private fleeTicks = 0;

    private lastBuryTime = Date.now();
    private readonly BURY_INTERVAL = 0.1 * 60 * 1000;
    private buryWaitTicks = 0;

    private currentNpc: Npc | null = null;
    /** Key of the NPC this instance has claimed in CLAIMED_NPCS, or -1 if none. */
    private claimedNpcKey = -1;

    private readonly stuck = new StuckDetector(30, 4, 2);
    private readonly watchdog = new ProgressWatchdog(150);

    private hasFoughtInArea = false;
    private readonly recentPickups = new WeakMap<Obj, number>();
    private pickup: Obj | null = null;

    /** True once we've done the initial weapon equip-from-inventory on first walk. */
    private _startEquipDone = false;

    /** Owner used to check target exclusions and active opponents. */
    private _lastPlayer: Player | null = null;
    private readonly unreachableNpcs = new Map<number, number>();

    constructor(step: SkillStep, stat: PlayerStat) {
        super('Combat');
        this.step = step;
        this.primaryStat = stat;
        this.stat = TRAIN_CYCLE[0].stat; // always start on attack
        this.watchdog.destination = step.location;
    }

    // ─────────────────────────────────────────────
    // LOGGING
    // ─────────────────────────────────────────────
    private _log(player: Player | null, msg: string, key = 'detail'): void {
        if (/timeout/i.test(msg)) BotLog.count('timeouts');
        BotLog.event('debug', player?.username ?? 'Combat', key, msg);
    }

    shouldRun(player: Player): boolean {
        return hasAllTools(player, this.step);
    }

    tick(player: Player): void {
        const now = Date.now();
        this._lastPlayer = player;

        if (this.interrupted) return;

        const banking = this.state === 'bank_walk' || this.state === 'bank_deposit';
        if (this.watchdog.check(player, banking)) {
            player.clearWaypoints();
            player.clearPendingAction();
            this._log(player, 'Combat deferred after inactivity', 'watchdog');
            this.stuck.reset();
            this._releaseNpc();
            this.currentNpc = null;
            this.scanFail = 0;
            this.fleeTicks = 0;
            this.cooldown = 0;
            this.state = 'walk';
            return;
        }

        if (player.delayed) return;
        if (this.cooldown > 0) {
            this.cooldown--;
            return;
        }

        // ── HP CHECK & HEALING ───────────────────────────────────────────────────
        const hp = player.levels[PlayerStat.HITPOINTS];
        const maxHp = player.baseLevels[PlayerStat.HITPOINTS];

        // Low HP check
        if (hp < maxHp * 0.4 && this.state !== 'bank_walk' && this.state !== 'bank_deposit' && this.state !== 'flee' && this.state !== 'eat') {
             this._releaseNpc();
             this.currentNpc = null;
             player.clearPendingAction();
             player.clearWaypoints();
             if (this._hasFood(player)) {
                 this._log(player, `HP low (${hp}/${maxHp}), eating...`, 'heal_trigger');
                 this.state = 'eat';
                 return;
             } else {
                 this._log(player, `HP low (${hp}/${maxHp}) and NO FOOD, fleeing!`, 'flee_low_hp');
                 this.state = 'flee';
                 this.fleeTicks = 0;
                 return;
             }
        }

        // ── AGGRESSOR DETECTION ──────────────────────────────────────────────────
        // Retreat if a stronger opponent interrupts training.
        const safeStates = ['bank_walk', 'bank_deposit', 'shop_walk', 'shop_open', 'shop_sell', 'flee', 'bury', 'eat', 'interact'];
        if (!safeStates.includes(this.state)) {
            const aggressor = findAggressorNpc(player, 8);
            if (aggressor && aggressor !== this.currentNpc) {
                const npcLvl = getNpcCombatLevel(aggressor);
                if (npcLvl > player.combatLevel) {
                    this._log(player, `fleeing from lvl-${npcLvl} ${this._npcLabel(aggressor)}`, 'flee_trigger');
                    this._releaseNpc();
                    this.currentNpc = null;
                    this.state = 'flee';
                    this.fleeTicks = 0;
                    return;
                }
            }
        }

        const hasBones = hasItem(player, Items.BONES) || hasItem(player, Items.BIG_BONES);

        const timeReady = now - this.lastBuryTime >= this.BURY_INTERVAL;
        const shouldBury = hasBones && timeReady;

        if (this.state === 'scan' && shouldBury) {
            this.state = 'bury';
            this._log(player, '→ bury bones', 'bury_bones');
            return;
        }

        if (this.state === 'bury') {
            const inv = player.getInventory(InvType.INV);
            if (!inv) {
                this.state = 'scan';
                return;
            }

            // Let the native bury script consume the bone and award Prayer XP.
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item) continue;

                if (item.id === Items.BONES || item.id === Items.BIG_BONES) {
                    interactHeldOp(player, inv, item.id, slot, 1);
                    this.cooldown = randInt(2, 4);
                    return;
                }
            }

            // Allow one tick for the final bury operation to finish.
            this.buryWaitTicks++;
            if (this.buryWaitTicks < 2) {
                return;
            }

            // All bones buried or server never delivered
            this._log(player, 'finished burying', 'bury_done');
            this.lastBuryTime = now;
            this.buryWaitTicks = 0;
            this.state = 'scan';
            return;
        }

        // ── INVENTORY FULL ───────────────────────────
        if (['scan', 'loot', 'walk'].includes(this.state) && isInventoryFull(player)) {
            // Check if we have junk to sell - prefer shop over banking
            if (this._hasJunkToSell(player)) {
                this._log(player, 'INVENTORY FULL → shop_walk (selling junk)', 'inv_full');
                this.state = 'shop_walk';
            } else {
                this._log(player, 'INVENTORY FULL → bank_walk', 'inv_full');
                this.state = 'bank_walk';
            }
            this.currentNpc = null;
            return;
        }

        // ── DUNGEON EXIT ──────────────────────────────
        if ((this.state === 'bank_walk' || this.state === 'shop_walk') && player.z > 6000) {
            this._defer(player, 'no verified dungeon exit');
            return;
        }

        // ── SHOP ──────────────────────────────────────
        if (this.state === 'shop_walk') {
            const [sx, sz, sl] = Locations.LUMBRIDGE_GENERAL;

            if (!isNear(player, sx, sz, 8, sl)) {
                walkTo(player, sx, sz);
                return;
            }

            const shopNpc = findNpcByName(player.x, player.z, player.level, 'generalshopkeeper1', 10);
            if (!shopNpc) return;

            interactNpcOp(player, shopNpc, 3);
            this.currentNpc = shopNpc;
            this.state = 'shop_open';
            this.cooldown = 2;
            return;
        }

        if (this.state === 'shop_open') {
            this.cooldown = 2;
            this.state = 'shop_sell';
            return;
        }

        if (this.state === 'shop_sell') {
            if (!this.currentNpc) {
                this.state = 'bank_walk';
                return;
            }

            this._sellJunk(player);

            if (!isInventoryFull(player)) {
                this.state = 'bank_walk';
                this.currentNpc = null;
            }

            return;
        }

        // ── BANK ──────────────────────────────────────
        if (this.state === 'bank_walk') {
            const result = advanceBankWalk(player, this.stuck, undefined, false);
            if (result === 'direct') { this._defer(player, 'no accessible banker'); return; }
            if (result === 'walk') return;
            this.cooldown = result === 'ready' ? 3 : 0;
            this.state = 'bank_deposit';
            return;
        }

        if (this.state === 'bank_deposit') {
            if (player.modalMain !== Interfaces.BANK_MAIN) {
                this._defer(player, 'bank interface did not open');
                return;
            }
            this._bankSupplies(player);
            player.closeModal();
            _equipLoot(player);
            this._rerollStep(player); // re-randomise location for the next run

            this.state = 'walk';
            this.cooldown = 3;
            return;
        }

        // ── WALK ──────────────────────────────────────
        if (this.state === 'walk') {
            // On first entry to walk (task just started or re-assigned after another task),
            // equip any weapon that accumulated in inventory (e.g. sword drops from a
            // previous RangedMagicTask run).  _equipLoot is also called after banking, so
            // this only matters for the very first walk before the first bank trip.
            if (!this._startEquipDone) {
                _equipLoot(player);
                this._startEquipDone = true;
            }

            // Check for loot only if:
            // 1. Bot is near the combat area (within 20 tiles)
            // 2. Has fought in this area before
            const [lx, lz, ll] = this.step.location;
            const inCombatArea = isNear(player, lx, lz, 20, ll);

            if (inCombatArea && this.hasFoughtInArea) {
                const lootObj = this._findDrop(player);
                if (lootObj) {
                    this.state = 'loot';
                    return;
                }
            }

            if (!isNear(player, lx, lz, 15, ll)) {
                // ── Dungeon navigation ─────────────────────────────────────────
                const extra = this.step.extra as { dungeon?: boolean } | undefined;
                if (extra?.dungeon && lz > 6000 && player.z < 6000) {
                    this._defer(player, 'no verified dungeon entry');
                    return;
                }

                // Via waypoint: route through intermediate coord before destination.
                // Used to steer around obstacles (e.g. Draynor Mansion for Barbarian
                // Village combat area).  Only apply when the bot hasn't yet passed it.
                const via = this.step.via;
                if (via && player.level === via[2] && player.z < via[1] && !isNear(player, via[0], via[1], 5)) {
                    const [jx, jz] = botJitter(player, via[0], via[1], 3);
                    walkTo(player, jx, jz);
                    return;
                }
                const [jx, jz] = botJitter(player, lx, lz, 6);
                walkTo(player, jx, jz);
                return;
            }

            this.state = 'scan';
            return;
        }

        // ── EAT ──────────────────────────────────────
        if (this.state === 'eat') {
            this._eatFood(player);
            return;
        }

        // ── FLEE ──────────────────────────────────────
        // Leave the training area on foot to seek supplies.
        // walkTo automatically uses MoveSpeed.RUN when runenergy >= 30 %.
        if (this.state === 'flee') {
            const [x, z, level] = nearestBank(player);
            const nearBank = isNear(player, x, z, 4, level);
            if (nearBank && FOOD_IDS.some(id => player.getInventory(bankInvId())?.contains(id))) {
                this.state = 'bank_walk';
            } else if (++this.fleeTicks > 30 || nearBank) {
                this._defer(player, 'retreat to recover health or supplies');
            } else {
                walkTo(player, x, z, level);
            }
            return;
        }

        if (this.state === 'scan') {
            if (pollObstacle(player)) return;
            if (this.hasFoughtInArea && this._findDrop(player)) {
                this.state = 'loot';
                return;
            }
            const weapon = player.getInventory(InvType.WORN)?.get(3);
            const tab = Component.get(player.tabs[0])?.comName;
            if (weapon && tab && !STYLE_BUTTONS[tab]) {
                interactIF_UseOp(player, Component.getId('wornitems:wear'), weapon.id, 3, 1);
                if (player.getInventory(InvType.WORN)?.get(3)) this._defer(player, 'unable to switch to melee');
                return;
            }
            const npc = this._findTargetNpc(player);
            if (!npc) {
                BotLog.count('combat_scan_empty');
                this.scanFail++;
                const blocked = this.blockedCandidate;
                if (this.scanFail <= 2 && blocked && openGateToward(player, blocked.x, blocked.z, 6, true)) return;
                if (this.scanFail >= 6) {
                    if (!this.triedSaferArea) {
                        this.triedSaferArea = true;
                        const chickens = SkillProgression.ATTACK.filter(step => step.extra?.npcType === 'chicken' &&
                            (step.location[0] !== this.step.location[0] || step.location[1] !== this.step.location[1]));
                        const distance = (step: SkillStep) => Math.abs(player.x - step.location[0]) + Math.abs(player.z - step.location[1]);
                        chickens.sort((a, b) => distance(a) - distance(b));
                        if (chickens[0]) {
                            this.step = chickens[0];
                            this.watchdog.destination = this.step.location;
                            this.scanFail = 0;
                            this.state = 'walk';
                            return;
                        }
                    }
                    this._defer(player, 'no reachable suitable melee target');
                } else {
                    const [x, z, level] = this.step.location;
                    walkTo(player, x, z, level);
                    this.cooldown = 3;
                }
                return;
            }
            this._claimNpc(npc);
            this.currentNpc = npc;
            this._selectStyle(player);
            interactNpcOp(player, npc, 2);
            this.state = 'interact';
            this.interactTicks = this.approachTicks = this.scanFail = 0;
            this.lastXp = this._meleeXp(player);
            return;
        }

        // ── LOOT ──────────────────────────────────────
        if (this.state === 'loot') {
            if (this.pickup && player.target === this.pickup && player.playtime < (this.recentPickups.get(this.pickup) ?? 0)) return;
            this.pickup = null;
            const obj = this._findDrop(player);
            if (!obj) {
                this.state = 'scan';
                return;
            }

            // Let the native interaction handle movement, ownership and receipt.
            this.pickup = obj;
            this.recentPickups.set(obj, player.playtime + INTERACT_TIMEOUT);
            interactObjOp(player, obj, 3);
            this.cooldown = 2;
            return;
        }

        // ── COMBAT ───────────────────────────────────
        if (this.state === 'interact') {
            this.interactTicks++;
            this.approachTicks++;

            const npc = this.currentNpc;
            if (!npc || !npc.isActive || npc.level !== player.level) {
                if (npc && !npc.isActive && npc.levels[NpcStat.HITPOINTS] === 0 && npc.heroPoints.findHero() === player.hash64) {
                    this.trainIndex = (this.trainIndex + 1) % TRAIN_CYCLE.length;
                    this.stat = TRAIN_CYCLE[this.trainIndex].stat;
                }
                this._releaseNpc();
                this.currentNpc = null;
                this.state = npc ? 'loot' : 'scan';
                return;
            }
            if (npc.target && npc.target !== player && npc.target instanceof Player) {
                this._releaseNpc();
                this.currentNpc = null;
                player.clearPendingAction();
                player.clearWaypoints();
                this.state = 'scan';
                return;
            }
            const xp = this._meleeXp(player);
            if (xp > this.lastXp) {
                this.watchdog.notifyActivity();
                this.hasFoughtInArea = true;
                this.interactTicks = this.approachTicks = 0;
            }
            this.lastXp = xp;
            const operable = player.inOperableDistance(npc);
            if (operable) this.approachTicks = 0;
            if (this.approachTicks >= INTERACT_TIMEOUT || this.interactTicks >= INTERACT_TIMEOUT * 4) {
                this.unreachableNpcs.set(npc.nid, player.playtime + 100);
                if (this.unreachableNpcs.size > 64) this.unreachableNpcs.delete(this.unreachableNpcs.keys().next().value!);
                const event = this.approachTicks >= INTERACT_TIMEOUT ? 'target_unreachable' : 'no_attack_timeout';
                BotLog.event('warn', player.username, event, 'Melee encounter stalled for NPC ' + npc.nid);
                this._releaseNpc();
                this.currentNpc = null;
                player.clearPendingAction();
                player.clearWaypoints();
                this.state = 'scan';
            } else if (this.interactTicks % this.noAttackTimeoutTicks === 0 && !player.hasInteraction() && !player.delayed) {
                interactNpcOp(player, npc, 2);
            }
        }
    }

    private _findDrop(player: Player): Obj | null {
        return findLootObj(player, player.x, player.z, player.level, 5,
            obj => obj.type !== Items.GOBLIN_MAIL && (this.recentPickups.get(obj) ?? 0) <= player.playtime);
    }

    private _meleeXp(player: Player): number {
        return player.stats[PlayerStat.ATTACK] + player.stats[PlayerStat.STRENGTH] + player.stats[PlayerStat.DEFENCE];
    }

    private _selectStyle(player: Player): void {
        const tab = player.tabs[0];
        const name = tab >= 0 ? Component.get(tab)?.comName : undefined;
        if (!name) return;
        const prefix = STYLE_BUTTONS[name];
        if (!prefix) return;
        const style = TRAIN_CYCLE[this.trainIndex].style;
        const index = style === 3 && (prefix === 'unarmed' || prefix === 'blunt') ? 2 : style;
        interactIfButtonByName(player, name + ':' + prefix + index);
    }

    private _defer(player: Player, reason: string): void {
        this._releaseNpc();
        this.currentNpc = null;
        (player as any)._bot?.deferCurrentTask(reason);
        this.interrupt();
    }

    isComplete(): boolean {
        return false;
    }

    override getDebugInfo(player: Player): BotTaskDebugInfo {
        const [lx, lz, ll] = this.step.location;
        const hp = player.levels[PlayerStat.HITPOINTS];
        const maxHp = player.baseLevels[PlayerStat.HITPOINTS];
        return {
            task: this.name,
            state: this.state,
            target: this.currentNpc ? `${NpcType.get(this.currentNpc.type).debugname ?? 'npc'}@(${this.currentNpc.x},${this.currentNpc.z})` : undefined,
            destination: { x: lx, z: lz, level: ll },
            details: {
                trainingStat: PlayerStatNameMap.get(this.stat) ?? `stat${this.stat}`,
                hp, maxHp,
                interactTicks: this.interactTicks,
                approachTicks: this.approachTicks,
                scanFail: this.scanFail,
                fleeTicks: this.fleeTicks,
                stuck: this.stuck.getDebugSnapshot()
            }
        };
    }

    override reset(): void {
        super.reset();

        this._lastPlayer = null;
        this._releaseNpc(); // ensure any held claim is freed on task reassignment

        this.pickup = null;
        this.triedSaferArea = false;
        this.blockedCandidate = null;
        this._startEquipDone = false;
        this.state = 'walk';
        this.interactTicks = 0;
        this.approachTicks = 0;
        this.lastXp = 0;
        this.scanFail = 0;
        this.currentNpc = null;
        this.unreachableNpcs.clear();

        this.trainIndex = 0;
        this.stat = TRAIN_CYCLE[0].stat;

        this.fleeTicks = 0;

        this.hasFoughtInArea = false;

        this.lastBuryTime = 0; // expire immediately so timer-fallback fires on first tick with bones
        this.buryWaitTicks = 0;

        this.stuck.reset();
        this.watchdog.reset();
    }

    private _npcLabel(npc: Npc): string {
        const anyNpc = npc as any;
        return anyNpc.type ?? anyNpc.name ?? anyNpc.index ?? 'unknown';
    }

    // ─────────────────────────────────────────────
    // NPC SEARCH
    // ─────────────────────────────────────────────

    /**
     * Returns true if the NPC is available to be targeted:
     *   - not currently in combat (target not set)
     *   - not already claimed by another CombatTask bot
     */
    private _isNpcAvailable(npc: Npc): boolean {
        const until = this.unreachableNpcs.get(npc.nid);
        if (until !== undefined) {
            if ((this._lastPlayer?.playtime ?? 0) < until) return false;
            this.unreachableNpcs.delete(npc.nid);
        }
        // Skip NPCs that already have a combat target (being fought by someone else)
        if (npc.target && npc.target !== this._lastPlayer) return false;
        // Skip NPCs already claimed by another bot this tick
        if (CLAIMED_NPCS.has(npc.nid)) return false;
        return true;
    }

    private _findTargetNpc(player: Player): Npc | null {
        this.blockedCandidate = null;
        const extra = this.step.extra as CombatExtra | undefined;
        if (!extra) return null;
        const names = [...(extra.npcTypes ?? []), extra.npcType, extra.npcName].filter((n): n is string => !!n);
        const worn = player.getInventory(InvType.WORN);
        const armour = [...ARMOR_WORN_SLOTS].filter(slot => worn?.get(slot)).length;
        const hp = player.levels[PlayerStat.HITPOINTS];
        const meleeLevel = Math.floor((player.levels[PlayerStat.DEFENCE] + hp) / 4 +
            (player.levels[PlayerStat.ATTACK] + player.levels[PlayerStat.STRENGTH]) * 0.325);
        const healthLimitedLevel = Math.min(meleeLevel, hp);
        const limit = Math.max(2, healthLimitedLevel + armour + (worn?.get(3) ? 2 : 0) + (this._hasFood(player) ? 3 : 0));
        const candidates: Npc[] = [];
        for (let dx = -16; dx <= 16; dx += 8) {
            for (let dz = -16; dz <= 16; dz += 8) {
                const zone = getWorld().gameMap.getZone(player.x + dx, player.z + dz, player.level);
                for (const npc of zone.getAllNpcsSafe()) {
                    if (!npc.isActive || npc.levels[NpcStat.HITPOINTS] === 0 || !this._isNpcAvailable(npc) || npc.level !== player.level) continue;
                    if (Math.max(Math.abs(npc.x - player.x), Math.abs(npc.z - player.z)) > 15) continue;
                    const type = NpcType.get(npc.type);
                    if (type.op?.[1]?.toLowerCase() !== 'attack' || type.vislevel > limit) continue;
                    if (names.some(name => npcMatchesName(npc, name)) ||
                        (extra.npcPrefix && type.debugname?.startsWith(extra.npcPrefix)) ||
                        (extra.npcSuffix && type.debugname?.endsWith(extra.npcSuffix))) candidates.push(npc);
                }
            }
        }
        const distance = (npc: Npc) => Math.abs(npc.x - player.x) + Math.abs(npc.z - player.z);
        candidates.sort((a, b) => distance(a) - distance(b));
        let best: Npc | null = null;
        let cost = Infinity;
        for (const npc of candidates.slice(0, 12)) {
            if (player.inOperableDistance(npc)) return npc;
            const path = findPathToEntity(player.level, player.x, player.z, npc.x, npc.z, player.width, npc.width, npc.length);
            if (!path.length) continue;
            const end = CoordGrid.unpackCoord(path[path.length - 1]);
            if (!reachedEntity(player.level, end.x, end.z, npc.x, npc.z, npc.width, npc.length, player.width) ||
                validateBotPath(player.level, player.x, player.z, path) !== 'ok') continue;
            let previous = { x: player.x, z: player.z };
            let steps = 0;
            for (const point of path) {
                const next = CoordGrid.unpackCoord(point);
                steps += Math.max(Math.abs(next.x - previous.x), Math.abs(next.z - previous.z));
                previous = next;
            }
            if (steps < cost) {
                cost = steps;
                best = npc;
            }
        }
        if (!best) this.blockedCandidate = candidates[0] ?? null;
        return best;
    }

    /** Register this bot's current target so other bots skip it. */
    private _claimNpc(npc: Npc): void {
        this._releaseNpc();
        this.claimedNpcKey = npc.nid;
        CLAIMED_NPCS.add(this.claimedNpcKey);
    }

    /** Release the current claim (NPC died, timed out, or task reset). */
    private _releaseNpc(): void {
        if (this.claimedNpcKey !== -1) {
            CLAIMED_NPCS.delete(this.claimedNpcKey);
            this.claimedNpcKey = -1;
        }
    }

    // ─────────────────────────────────────────────
    // STEP RE-ROLL
    // ─────────────────────────────────────────────

    /**
     * After each bank trip, pick a fresh random step from all tiers the bot
     * qualifies for (level + tool ownership).  This spreads bots across
     * locations every inventory cycle instead of every level-up.
     */
    private _rerollStep(player: Player): void {
        const level = getBaseLevel(player, this.primaryStat);
        const skillName = this.primaryStat === PlayerStat.ATTACK ? 'ATTACK' : this.primaryStat === PlayerStat.STRENGTH ? 'STRENGTH' : 'DEFENCE';
        const newStep = getProgressionStep(skillName, level, ids => ids.every(id => hasStepTool(player, this.step, id)));
        if (newStep) {
            this.step = newStep;
            this.watchdog.destination = newStep.location;
        }
    }

    // ─────────────────────────────────────────────
    // SHOP + BANK
    // ─────────────────────────────────────────────
    private _hasJunkToSell(player: Player): boolean {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return false;

        const protectedItems = new Set(this.step.toolItemIds);

        // Check if any item can be sold (not a tool item, not coins, not a banked herb/talisman)
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;
            if (protectedItems.has(item.id) || FOOD_IDS.includes(item.id)) continue;
            if (item.id === Items.COINS) continue;
            if (GRIMY_HERB_MAP[item.id] !== undefined) continue; // grimy herb → bank
            if (item.id === Items.AIR_TALISMAN) continue; // talisman → bank
            return true;
        }

        return false;
    }

    private _sellJunk(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) return;

        const protectedItems = new Set(this.step.toolItemIds);

        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item) continue;

            if (protectedItems.has(item.id) || FOOD_IDS.includes(item.id)) continue;
            if (item.id === Items.COINS) continue; //<- also not needed anymore.
            if (GRIMY_HERB_MAP[item.id] !== undefined) continue; // grimy herb → bank
            if (item.id === Items.AIR_TALISMAN) continue; // talisman → bank

            if (interactIF_UseOp(player, Interfaces.SHOP_SIDE_INV, item.id, slot, 4)) {
                //info: Op 4 is sell 10 (Op1 value, op2 sell 1, op3 sell 5, op4 sell 10)(for SHOP_SIDE) Interfaces.SHOP_INV for buy
                BotLog.debug('(' + player.displayName + ') successfully sold item to shop: ' + item.id);
            } else {
                BotLog.debug('Could not sell item to shop! (' + item.id + ') for (' + player.displayName + ')');
            }
            //todo: check if more than 10 and repeat interfaceIF_UseOp
        }
    }

    private _hasFood(player: Player): boolean {
        for (const id of FOOD_IDS) {
            if (hasItem(player, id)) return true;
        }
        return false;
    }

    private _eatFood(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        if (!inv) {
            this.state = 'walk';
            return;
        }

        for (const foodId of FOOD_IDS) {
            for (let slot = 0; slot < inv.capacity; slot++) {
                const item = inv.get(slot);
                if (!item || item.id !== foodId) continue;

                // Use the food
                interactHeldOp(player, inv, foodId, slot, 1);
                this._log(player, `ate ${foodId} to heal`, 'ate_food');
                this.cooldown = 3;

                // After eating, if HP is still relatively low and we have more food,
                // stay in eat state. Otherwise return to previous activity.
                const hp = player.levels[PlayerStat.HITPOINTS];
                const maxHp = player.baseLevels[PlayerStat.HITPOINTS];
                if (hp < maxHp * 0.8 && this._hasFood(player)) {
                    this.state = 'eat';
                } else {
                    this.state = 'walk';
                }
                return;
            }
        }

        // Out of food
        this.state = 'walk';
    }

    /** Issue the same bank inventory buttons and quantity reply as a player. */
    private _bankSupplies(player: Player): void {
        const inv = player.getInventory(InvType.INV);
        const bank = player.getInventory(bankInvId());
        if (!inv || !bank) return;

        const transfer = (component: number, id: number, slot: number, count?: number) => {
            if (!interactIF_UseOp(player, component, id, slot, count === undefined ? 4 : 5)) return;
            if (count !== undefined && player.activeScript?.execution === ScriptState.COUNTDIALOG) {
                player.activeScript.lastInt = count;
                player.executeScript(player.activeScript, true, true);
            }
        };
        for (let slot = 0; slot < inv.capacity; slot++) {
            const item = inv.get(slot);
            if (!item || this.step.toolItemIds.includes(item.id) || FOOD_IDS.includes(item.id)) continue;
            if (item.id === Items.COINS) {
                if (item.count > 200) transfer(Interfaces.BANK_SIDE_INV, item.id, slot, item.count - 200);
            } else {
                transfer(Interfaces.BANK_SIDE_INV, item.id, slot);
            }
        }

        const worn = player.getInventory(InvType.WORN);
        const weapon = SCIMITAR_TIERS.find(tier => tier.minAtk <= player.baseLevels[PlayerStat.ATTACK] &&
            (worn?.contains(tier.itemId) || inv.contains(tier.itemId) || bank.contains(tier.itemId)));
        const armour = ARMOR_SETS.find(set => set.minDef <= player.baseLevels[PlayerStat.DEFENCE]);
        const desired = new Set(armour?.pieces);
        if (weapon) desired.add(weapon.itemId);
        let food = FOOD_IDS.reduce((total, id) => total + countItem(player, id), 0);
        for (let slot = 0; slot < bank.capacity && inv.hasSpace; slot++) {
            const item = bank.get(slot);
            if (!item) continue;
            if (desired.has(item.id) && !worn?.contains(item.id) && !inv.contains(item.id)) {
                transfer(Interfaces.BANK_MAIN_INV, item.id, slot, 1);
            } else if (FOOD_IDS.includes(item.id)) {
                const goal = item.id === Items.SHARK ? COMBAT_SHARKS : 8;
                if (food >= goal) continue;
                const before = countItem(player, item.id);
                transfer(Interfaces.BANK_MAIN_INV, item.id, slot, goal - food);
                food += countItem(player, item.id) - before;
            }
        }
    }
}
