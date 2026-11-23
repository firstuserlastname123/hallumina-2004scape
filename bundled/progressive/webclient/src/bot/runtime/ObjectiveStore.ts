import type { Progress } from '../api/Script.js';
import type { Settings } from './Settings.js';
export interface Objective { version: 1; script: string; settings: Settings; progress: Progress; savedAt: number }
export class ObjectiveStore {
    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, private readonly world: string) {}
    private key(account: string): string { return `hallumina:personal:v1:${this.world}:${account.toLowerCase()}`; }
    load(account: string): Objective | null {
        try {
            const value = JSON.parse(this.storage?.getItem(this.key(account)) ?? 'null');
            if (value?.version !== 1 || typeof value.script !== 'string' || !value.settings || !value.progress ||
                !['gathered', 'banked', 'cycles', 'elapsed'].every(k => Number.isFinite(value.progress[k]) && value.progress[k] >= 0)) return null;
            return value;
        } catch { return null; }
    }
    save(account: string, value: Objective): boolean {
        try { if (!this.storage) return false; this.storage.setItem(this.key(account), JSON.stringify(value)); return true; } catch { return false; }
    }
    clear(account: string): void { try { this.storage?.removeItem(this.key(account)); } catch { /* Storage may be disabled. */ } }
    preferences(account: string, script: string): Settings {
        try {
            const value = JSON.parse(this.storage?.getItem(`${this.key(account)}:preferences:${script}`) ?? '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch { return {}; }
    }
    savePreferences(account: string, script: string, settings: Settings): void {
        try { this.storage?.setItem(`${this.key(account)}:preferences:${script}`, JSON.stringify(settings)); } catch { /* Optional storage. */ }
    }
}
