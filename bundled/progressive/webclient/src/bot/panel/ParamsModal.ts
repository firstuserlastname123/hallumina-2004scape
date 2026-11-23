import type { ScriptMeta } from '../runtime/ScriptRegistry.js';
import { resolveSettings, type Settings } from '../runtime/Settings.js';
import { button, el } from './dom.js';
/** Schema-generated parameter form, following rs2b0t's ParamsModal pattern. */
export class ParamsModal {
    private readonly dialog = el('dialog');
    constructor() { this.dialog.className = 'hb-dialog'; document.body.append(this.dialog); }
    open(meta: ScriptMeta, initial: Settings, start: (settings: Settings) => void): void {
        this.dialog.replaceChildren(); const form = el('form'); const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
        form.append(el('h2', meta.name), el('p', meta.description));
        for (const [key, def] of Object.entries(meta.settingsSchema)) {
            const label = el('label', def.label); let input: HTMLInputElement | HTMLSelectElement;
            if (def.type === 'string') {
                input = el('select'); for (const value of def.options) { const option = el('option', value); option.value = value; input.append(option); }
                input.value = String(initial[key] ?? def.default);
            } else {
                input = el('input'); input.type = def.type === 'boolean' ? 'checkbox' : 'number';
                if (def.type === 'boolean') input.checked = Boolean(initial[key] ?? def.default);
                else { input.min = String(def.min); input.max = String(def.max); input.step = '1'; input.value = String(initial[key] ?? def.default); input.required = true; }
            }
            input.name = key; label.append(input); form.append(label); controls.set(key, input);
        }
        const error = el('p', '', 'hb-error'); error.setAttribute('role', 'alert');
        const cancel = button('Cancel', () => this.dialog.close()), submit = el('button', 'Start script'); submit.type = 'submit';
        form.append(error, cancel, submit);
        form.addEventListener('submit', event => {
            event.preventDefault();
            try {
                const values = Object.fromEntries([...controls].map(([key, input]) => [key, input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value]));
                start(resolveSettings(meta.settingsSchema, values)); this.dialog.close();
            } catch (e) { error.textContent = e instanceof Error ? e.message : String(e); }
        });
        this.dialog.append(form); this.dialog.showModal();
    }
}
