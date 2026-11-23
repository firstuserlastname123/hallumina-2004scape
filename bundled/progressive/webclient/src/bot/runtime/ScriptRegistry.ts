// Adapted from rs2b0t's metadata registry. See bot/NOTICE.
import type { BotScript } from '../api/Script.js';
import type { SettingsSchema } from './Settings.js';
export interface ScriptMeta {
    id: string; name: string; description: string; version: string; category: string; tags: readonly string[];
    progressUnit?: string; skill?: { id: number; name: string };
    settingsSchema: SettingsSchema; create(): BotScript;
}
export class ScriptRegistry {
    private readonly scripts = new Map<string, ScriptMeta>();
    register(meta: ScriptMeta): void {
        if (this.scripts.has(meta.id)) throw new Error(`Duplicate script: ${meta.id}`);
        this.scripts.set(meta.id, Object.freeze(meta));
    }
    get(id: string): ScriptMeta | undefined { return this.scripts.get(id); }
    list(query = '', category = 'All'): ScriptMeta[] {
        return [...this.scripts.values()].filter(meta => (category === 'All' || meta.category === category) &&
            `${meta.name} ${meta.description} ${meta.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase().trim()));
    }
}
