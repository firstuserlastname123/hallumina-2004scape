import type { ScriptMeta, ScriptRegistry } from '../runtime/ScriptRegistry.js';
import { el, button } from './dom.js';
/** Search/category/card pattern adapted from rs2b0t ScriptLibrary. See bot/NOTICE. */
export class ScriptLibrary {
    readonly root = el('section');
    private query = el('input');
    private category = el('select');
    private cards = el('div');
    constructor(registry: ScriptRegistry, select: (meta: ScriptMeta) => void) {
        this.root.append(el('h3', 'Script library'));
        this.query.type = 'search'; this.query.placeholder = 'Search scripts or tags'; this.query.setAttribute('aria-label', 'Search scripts');
        this.category.setAttribute('aria-label', 'Script category');
        for (const name of ['All', ...new Set(registry.list().map(m => m.category))]) {
            const option = el('option', name); option.value = name; this.category.append(option);
        }
        const render = () => {
            this.cards.replaceChildren();
            const scripts = registry.list(this.query.value, this.category.value);
            if (!scripts.length) this.cards.append(el('p', 'No matching scripts', 'hb-muted'));
            for (const meta of scripts) {
                const card = button('', () => select(meta)); card.className = 'hb-card';
                card.append(el('strong', meta.name), el('span', `${meta.category} · v${meta.version}`, 'hb-muted'), el('p', meta.description), el('small', meta.tags.map(t => `#${t}`).join(' '), 'hb-muted'));
                this.cards.append(card);
            }
        };
        this.query.addEventListener('input', render); this.category.addEventListener('change', render);
        this.root.append(this.query, this.category, this.cards); render();
    }
}
