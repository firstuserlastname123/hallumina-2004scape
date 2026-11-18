import Component from '#/cache/config/Component.js';
import type Player from '#/engine/entity/Player.js';
import IfSetText from '#/network/game/server/model/IfSetText.js';
import ResumePauseButton from '#/network/game/client/model/ResumePauseButton.js';
import ResumePauseButtonHandler from '#/network/game/client/handler/ResumePauseButtonHandler.js';
import IfButton from '#/network/game/client/model/IfButton.js';
import IfButtonHandler from '#/network/game/client/handler/IfButtonHandler.js';
import ScriptState from '#/engine/script/ScriptState.js';
const labels = new WeakMap<Player, Map<number, string>>();
/** Observe the same interface messages a client receives; preserve normal delivery. */
export function attachBotDialogue(player: Player): void {
    if (labels.has(player)) return;
    const texts = new Map<number, string>();
    labels.set(player, texts);
    const write = player.write.bind(player);
    player.write = message => {
        if (message instanceof IfSetText) {
            if (texts.size >= 256 && !texts.has(message.component)) texts.clear();
            texts.set(message.component, message.text.replace(/<[^>]*>/g, '').trim());
        }
        write(message);
    };
}
/** Only resume a dialogue owned by the caller, using registered native buttons. */
export function answerBotDialogue(player: Player, choices: RegExp): boolean {
    if (player.delayed || player.activeScript?.execution !== ScriptState.PAUSEBUTTON) return false;
    const buttons = player.resumeButtons.filter(id => Component.get(id)?.rootLayer === player.modalChat);
    if (buttons.length === 0) {
        new ResumePauseButtonHandler().handle(new ResumePauseButton(), player);
        return true;
    }
    const chosen = buttons.length === 1 ? buttons[0] : buttons.find(id => choices.test(labels.get(player)?.get(id) ?? ''));
    if (chosen === undefined) return false;
    new IfButtonHandler().handle(new IfButton(chosen), player);
    return true;
}
