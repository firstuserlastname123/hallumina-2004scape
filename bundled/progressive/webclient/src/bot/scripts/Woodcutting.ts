import type { BotScript, ScriptContext } from '../api/Script.js';
import type { Observation, SceneObject, Tile } from '../api/Types.js';
import { distance, total } from '../api/Types.js';
import { defineBot } from '../runtime/defineBot.js';

const LOGS = 1511, CENTRE: Tile = { x: 3102, z: 3240, level: 0 };
const AXES = new Map([[1351, 1], [1349, 1], [1353, 6], [1355, 21], [1357, 31], [1359, 41], [1361, 6]]);
export const woodcutting = defineBot({
    id: 'woodcutting', name: 'Woodcutting', version: '1.0.0', category: 'Skills', tags: ['gathering', 'logs', 'banking'],
    description: 'Chop normal trees near Draynor bank. Bank logs through the native bank interface and keep your axe.',
    settingsSchema: {
        location: { type: 'string', label: 'Location', default: 'Draynor normal trees', options: ['Draynor normal trees'] },
        target: { type: 'number', label: 'Logs to gather (0 = duration)', default: 54, min: 0, max: 10000 },
        minutes: { type: 'number', label: 'Maximum active minutes', default: 30, min: 1, max: 240 },
        banking: { type: 'boolean', label: 'Bank logs', default: true }
    }, create: () => new Woodcutting()
});
export class Woodcutting implements BotScript {
    private previousLogs = 0;
    private previousXp = 0;
    private lastResultId = 0;
    private failures = 0;
    private waitingSince = 0;
    private target: SceneObject | null = null;
    private ignored = new Map<string, number>();
    private banking = false;
    private objectiveMet = false;
    private readonly key = (o: SceneObject) => `${o.id}:${o.x}:${o.z}`;
    onStart(ctx: ScriptContext, s: Observation): void { this.validate(s); this.baseline(s); ctx.status('Inspecting Draynor trees'); }
    private validate(s: Observation): void {
        if (!s.position || distance(s.position, CENTRE) > 30) throw new Error('Start on the ground floor within 30 tiles of Draynor normal trees (3102, 3240). Complete Tutorial Island and travel there manually.');
        if (![...s.inventory, ...s.equipment].some(i => AXES.has(i.id) && AXES.get(i.id)! <= (s.skills[8]?.level ?? 0))) throw new Error('Carry or equip an axe usable at your Woodcutting level');
        if (s.health <= 0) throw new Error('Character is not alive');
    }
    private baseline(s: Observation): void { this.previousLogs = total(s.inventory, LOGS); this.previousXp = s.skills[8]?.xp ?? 0; this.target = null; }
    onResume(s: Observation): void { this.validate(s); this.baseline(s); this.waitingSince = 0; this.failures = 0; this.banking = s.bank !== null || s.inventory.length >= 28; }
    onTick(ctx: ScriptContext, s: Observation): void {
        this.validate(s);
        const logs = total(s.inventory, LOGS), xp = s.skills[8]?.xp ?? 0;
        if (logs > this.previousLogs && xp > this.previousXp) {
            const gained = Math.min(logs - this.previousLogs, Math.floor((xp - this.previousXp) / 25));
            ctx.progress.gathered += gained; this.failures = 0; this.waitingSince = 0;
            ctx.log(`Verified ${gained} logs and ${xp - this.previousXp} Woodcutting XP`);
        }
        this.previousLogs = logs; this.previousXp = xp;
        const r = ctx.lastResult;
        if (r && r.id !== this.lastResultId && !['dispatched', 'pending'].includes(r.state)) {
            this.lastResultId = r.id;
            if (['timeout', 'blocked'].includes(r.state)) {
                this.failures++; ctx.log(`Recovery ${this.failures}/3: ${r.reason}`, 'warn');
                if (this.target) this.ignored.set(this.key(this.target), s.at + 30_000);
                this.target = null;
                if (this.failures >= 3) { ctx.pause('Three unsuccessful actions; inspect the character and Resume'); return; }
            } else if (r.state === 'success') this.failures = 0;
        }
        this.objectiveMet = (Number(ctx.settings.target) > 0 && ctx.progress.gathered >= Number(ctx.settings.target)) || ctx.progress.elapsed >= Number(ctx.settings.minutes) * 60_000;
        if (this.objectiveMet && (!ctx.settings.banking || !logs) && s.bank === null) { ctx.complete('Woodcutting objective complete'); return; }
        if (s.bank !== null) {
            this.banking = true;
            if (logs) {
                const item = s.inventory.find(i => i.id === LOGS)!, bankBefore = total(s.bank, LOGS);
                ctx.status(`Banking ${logs} logs`);
                ctx.act({ kind: 'deposit', id: LOGS, slot: item.slot }, after => {
                    if (after.bank === null) return false;
                    const deposited = logs - total(after.inventory, LOGS);
                    if (deposited > 0 && total(after.bank, LOGS) - bankBefore >= deposited) {
                        ctx.progress.banked += deposited; ctx.progress.cycles++; return true;
                    }
                    return false;
                }, 12_000);
            } else { ctx.status('Closing bank'); ctx.act({ kind: 'close-bank' }, after => after.bank === null, 6000); this.banking = false; }
            return;
        }
        if (s.interfaces.some(i => i.buttonType === 6)) {
            // Native level-up continuation only; other dialogue requires the player.
            if (s.interfaces.some(i => /woodcutting level|advanced a woodcutting/i.test(i.text))) {
                const next = s.interfaces.find(i => i.buttonType === 6)!;
                ctx.act({ kind: 'dialogue', component: next.id }, after => !after.interfaces.some(i => i.id === next.id), 6000);
            } else ctx.pause('Unexpected dialogue; handle it manually and Resume');
            return;
        }
        if (this.banking || s.inventory.length >= 28 || this.objectiveMet) {
            if (!ctx.settings.banking) { ctx.complete('Inventory full; banking is disabled'); return; }
            if (!logs) { ctx.pause('Inventory is full of protected items; make space manually'); return; }
            this.banking = true; this.target = null;
            const bank = s.objects.filter(o => /bank booth/i.test(o.name) && distance(o, CENTRE) <= 24 && o.options.some(op => /use-quickly|^bank$/i.test(op ?? '')))
                .sort((a, b) => distance(a, s.position!) - distance(b, s.position!))
                .find(o => ctx.game.approach(o, o.width, o.length));
            if (!bank) { ctx.pause('No reachable Draynor bank booth; check doors or walk closer'); return; }
            ctx.status('Walking to bank');
            ctx.act({ kind: 'object', id: bank.id, tile: bank, option: bank.options.find(op => /use-quickly|^bank$/i.test(op ?? ''))! }, after => after.bank !== null, 24_000);
            return;
        }
        if (this.target) {
            const live = s.objects.find(o => o.id === this.target!.id && o.x === this.target!.x && o.z === this.target!.z);
            if (live && (s.moving || s.animation !== -1)) { ctx.status(`Chopping at ${live.x}, ${live.z}`); return; }
            this.target = null;
        }
        const tree = s.objects.filter(o => o.name === 'Tree' && o.options.includes('Chop down') && distance(o, CENTRE) <= 18 && (this.ignored.get(this.key(o)) ?? 0) <= s.at)
            .sort((a, b) => distance(a, s.position!) - distance(b, s.position!))
            .find(o => ctx.game.approach(o, o.width, o.length));
        if (!tree) {
            this.waitingSince ||= s.at; ctx.status('Waiting for a reachable normal tree to respawn');
            if (s.at - this.waitingSince > 60_000) ctx.pause('No reachable normal trees for one minute; inspect and Resume');
            return;
        }
        this.waitingSince = 0; this.target = tree; ctx.status(`Approaching tree ${tree.x}, ${tree.z}`);
        ctx.act({ kind: 'object', id: tree.id, tile: tree, option: 'Chop down' }, after => total(after.inventory, LOGS) > logs && (after.skills[8]?.xp ?? 0) > xp, 45_000);
    }
}
