/**
 * ShopTripTask.ts
 *
 * Walk to a shop NPC, trade, and buy a specific item.
 * Verifies the native shop interface and purchases only available native stock.
 * If coins run out, shouldRun() returns false and the planner re-routes.
 *
 * Shared navigation owns bounded route recovery and task deferral.
 */

import { findReachableNpc, npcMatchesName, interactIF_UseOp } from '#/engine/bot/BotAction.js';
import { Interfaces } from '#/engine/bot/BotKnowledge.js';
import { findNpcApproach } from '#/engine/bot/BotNavigation.js';
import {
    BotTask, Player,
    walkTo, interactNpcOp,
    countItem, isNear, isInventoryFull,
    Items, Shops,
} from '#/engine/bot/tasks/BotTaskBase.js';

export class ShopTripTask extends BotTask {
    private readonly shopKey:  string;
    private readonly itemId:   number;
    private readonly quantity: number;
    private readonly costEach: number;
    private readonly npcName:  string;

    private state: 'walk' | 'find' | 'interact' | 'buy' | 'done' = 'walk';
    private waitTicks     = 0;
    private purchased = 0;
    private findFailTicks = 0;

    private static readonly NPC_NAMES: Record<string, string> = {
        BOB_AXES:            'bob',
        GERRANTS_FISHING:    'gerrant',
        VARROCK_SWORDS:      'swordshop1',
        VARROCK_ARCHERY:     'lowe',
        VARROCK_RUNES:       'aubury',
        AL_KHARID_SCIMITARS: 'zeke',
        LUMBRIDGE_GENERAL:   'generalshopkeeper1',
        // Was missing entirely — fell back to using the shop KEY itself as the
        // NPC name ("AL_KHARID_CRAFTING", not a real NPC), so findNpcByName()
        // in the 'find' state could never find anyone and bots paced at
        // (3285,3183) forever. Real debugname confirmed via
        // content/scripts/areas/area_alkharid/scripts/dommik.rs2.
        AL_KHARID_CRAFTING:  'dommik',
    };

    constructor(shopKey: string, itemId: number, quantity: number, costEach: number) {
        super('ShopTrip');
        this.shopKey  = shopKey;
        this.itemId   = itemId;
        this.quantity = quantity;
        this.costEach = costEach;
        this.npcName  = ShopTripTask.NPC_NAMES[shopKey] ?? shopKey;
    }

    shouldRun(player: Player): boolean {
        if (this.state === 'done') return false;
        // No point walking to shop if we can't afford anything
        if (countItem(player, Items.COINS) < this.costEach) return false;
        // Can't receive the purchased item if the inventory is already full —
        // the bot must bank first. Returning false here lets the planner re-route
        // to a gathering task whose bank_walk state will clear space.
        if (isInventoryFull(player)) return false;
        return true;
    }

    tick(player: Player): void {
        if (this.interrupted) return;
        if (this.cooldown > 0) { this.cooldown--; return; }

        const shop = Shops[this.shopKey];
        if (!shop) { this.state = 'done'; return; }
        const [sx, sz, sl] = shop.location;

        // ── Walk to shop ──────────────────────────────────────────────────────
        if (this.state === 'walk') {
            if (!isNear(player, sx, sz, 8, sl)) {
                walkTo(player, sx, sz, sl);
                return;
            }
            this.state         = 'find';
            this.findFailTicks = 0;
            return;
        }

        // ── Find shop NPC ─────────────────────────────────────────────────────
        if (this.state === 'find') {
            const npc = findReachableNpc(player, 10, npc => npcMatchesName(npc, this.npcName));
            if (!npc) {
                this.findFailTicks++;
                walkTo(player, sx, sz);
                // A missing or unreachable service eventually yields to the planner.
                if (this.findFailTicks >= 40) {
                    (player as any)._bot?.deferCurrentTask('no reachable shopkeeper');
                    this.state         = 'find';
                    this.findFailTicks = 0;
                }
                return;
            }
            const route = findNpcApproach(player, npc)!;
            interactNpcOp(player, npc, 3); // op3 = Trade on all shops
            player.clearWaypoints();
            if (route.path.length) player.queueWaypoints(route.path);
            this.state     = 'interact';
            this.waitTicks = 0;
            return;
        }

        // ── Wait for shop to open ─────────────────────────────────────────────
        if (this.state === 'interact') {
            if (player.modalMain === Interfaces.SHOP) this.state = 'buy';
            else if (++this.waitTicks >= 25 && !player.delayed && !player.activeScript) {
                this.state = 'find';
                this.findFailTicks++;
                if (this.findFailTicks >= 3) (player as any)._bot?.deferCurrentTask('shop interaction unavailable');
            }
            return;
        }

        // ── Buy item ──────────────────────────────────────────────────────────
        if (this.state === 'buy') {
            const bought = this._buy(player);
            if (bought > 0) {
                this.purchased += bought;
                this.state = this.purchased >= this.quantity ? 'done' : 'buy';
            } else {
                // Ran out of coins during journey — reset and let planner decide
                (player as any)._bot?.deferCurrentTask('native shop purchase refused');
            }
        }
    }

    isComplete(_p: Player): boolean { return this.state === 'done'; }

    override reset(): void {
        super.reset();
        this.state         = 'walk';
        this.waitTicks     = 0;
        this.findFailTicks = 0;
        this.purchased = 0;
    }

    private _buy(player: Player): number {
        if (player.modalMain !== Interfaces.SHOP) return 0;
        const listener = player.invListeners.find(listener => listener.com === Interfaces.SHOP_INV);
        const stock = listener && player.getInventoryFromListener(listener);
        if (!stock) return 0;
        const slot = stock.items.findIndex(item => item?.id === this.itemId);
        if (slot < 0 || (stock.get(slot)?.count ?? 0) <= 0) {
            (player as any)._bot?.deferCurrentTask('shop stock unavailable');
            return 0;
        }
        const before = countItem(player, this.itemId);
        // The native script enforces price, stock, ownership and room.
        const remaining = this.quantity - this.purchased;
        interactIF_UseOp(player, Interfaces.SHOP_INV, this.itemId, slot, remaining >= 10 ? 4 : remaining >= 5 ? 3 : 2);
        return Math.max(0, countItem(player, this.itemId) - before);
    }

}
