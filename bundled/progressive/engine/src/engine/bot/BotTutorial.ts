import Component from '#/cache/config/Component.js';
import InvType from '#/cache/config/InvType.js';
import NpcType from '#/cache/config/NpcType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { findNpcByName, interactNpcOp } from '#/engine/bot/BotAction.js';
import { randomBotDesign } from '#/engine/bot/BotAppearance.js';
import { answerBotDialogue } from '#/engine/bot/BotDialogue.js';
import type { BotGoalPlanner } from '#/engine/bot/BotGoalPlanner.js';
import { BotLog } from '#/engine/bot/BotLog.js';
import { onTutorialIsland } from '#/engine/bot/BotTravel.js';
import { getExpByLevel } from '#/engine/entity/Player.js';
import type Player from '#/engine/entity/Player.js';
import { PlayerStat } from '#/engine/entity/PlayerStat.js';
import IfButtonHandler from '#/network/game/client/handler/IfButtonHandler.js';
import IdkSaveDesignHandler from '#/network/game/client/handler/IdkSaveDesignHandler.js';
import IfButton from '#/network/game/client/model/IfButton.js';

const GUIDE = 'newbie_basics_instructor';
const DESIGNED_CHARACTER = 1; // r254 tutorial.constant
const TUTORIAL_COMPLETE = 1000; // r254 quest.constant

export function needsBotTutorial(player: Player): boolean {
    return player.botTutorialPending || (onTutorialIsland(player.x, player.z) &&
        player.vars[VarPlayerType.getId('tutorial')] < TUTORIAL_COMPLETE);
}

function hasStarterProgress(player: Player): boolean {
    const startingHpXp = getExpByLevel(10);
    return player.stats.some((xp, stat) => xp !== (stat === PlayerStat.HITPOINTS ? startingHpXp : 0)) ||
        [...player.invs].some(([id, inv]) => InvType.get(id).scope === InvType.SCOPE_PERM && !inv.isEmpty);
}

/** Hold ordinary activity until native completion. Unenrolled saves are left at their own stage. */
export class BotTutorial {
    private retryAt = 0;
    private reported = false;
    private finished = false;

    tick(player: Player, planner: BotGoalPlanner): boolean {
        if (this.finished) return false;
        const stage = player.vars[VarPlayerType.getId('tutorial')];
        const onIsland = onTutorialIsland(player.x, player.z);
        if (player.botTutorialPending && stage >= TUTORIAL_COMPLETE && !onIsland && !player.delayed && !player.activeScript) {
            player.botTutorialPending = false;
            planner.enableFreshProfile();
            this.finished = true;
            BotLog.event('debug', player.username, 'tutorial_completed', 'Native tutorial completed on the mainland');
            return true;
        }
        if (!player.botTutorialPending || (onIsland && (stage > DESIGNED_CHARACTER || hasStarterProgress(player)))) {
            player.botTutorialPending = false;
            if (!this.reported) {
                BotLog.event('warn', player.username, 'tutorial_preserved', 'Existing Tutorial Island progress requires the native tutorial');
                this.reported = true;
            }
            return true;
        }
        if (player.delayed || !onIsland) return true;

        const script = player.activeScript;
        if (script) {
            if (script._activeNpc?.type === NpcType.getId(GUIDE)) {
                answerBotDialogue(player, /^Yes please\.$/);
            }
            return true;
        }
        if (player.playtime < this.retryAt) return true;
        this.retryAt = player.playtime + 5;
        if (stage === 0 && player.allowDesign && player.modalMain === Component.getId('player_kit')) {
            if (new IdkSaveDesignHandler().handle(randomBotDesign(), player)) {
                new IfButtonHandler().handle(new IfButton(Component.getId('player_kit:accept')), player);
            }
        } else if (stage === DESIGNED_CHARACTER && !player.hasInteraction()) {
            const guide = findNpcByName(player.x, player.z, player.level, GUIDE);
            if (guide) interactNpcOp(player, guide, 1);
        }
        return true;
    }
}
