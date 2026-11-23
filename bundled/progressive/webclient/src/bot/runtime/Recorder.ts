import type { Observation } from '../api/Types.js';
export interface RecordedEvent { sequence: number; timestamp: string; type: string; data: unknown; before?: unknown; after?: unknown }
/** Explicit allowlist: no client object, chat, credentials, packets, or arbitrary browser state. */
export function evidence(s: Observation): unknown {
    return { sequence: s.sequence, at: s.at, position: s.position, inventory: s.inventory, equipment: s.equipment,
        skills: s.skills, interfaces: s.interfaces, quests: s.quests, bank: s.bank, animation: s.animation, moving: s.moving };
}
export class Recorder {
    enabled = false;
    private sequence = 0;
    private bytes = 0;
    private events: RecordedEvent[] = [];
    private previous: Observation | null = null;
    dropped = 0;
    constructor(private readonly maxEvents = 1500, private readonly maxBytes = 4 * 1024 * 1024) {}
    setEnabled(enabled: boolean): void { this.enabled = enabled; this.previous = null; if (enabled) this.record('recording-started', {}); }
    record(type: string, data: unknown, before?: Observation, after?: Observation): void {
        if (!this.enabled) return;
        const event = { sequence: ++this.sequence, timestamp: new Date().toISOString(), type, data,
            ...(before ? { before: evidence(before) } : {}), ...(after ? { after: evidence(after) } : {}) };
        const size = JSON.stringify(event).length * 2;
        if (size > this.maxBytes) { this.dropped++; return; }
        this.events.push(event); this.bytes += size;
        while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
            this.bytes -= JSON.stringify(this.events.shift()).length * 2; this.dropped++;
        }
    }
    observe(after: Observation): void {
        if (!this.enabled) return;
        const before = this.previous;
        if (before && before.account === after.account) {
            for (const key of ['position', 'inventory', 'equipment', 'skills', 'interfaces', 'quests'] as const) {
                if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) this.record(`observed-${key}`, {}, before, after);
            }
        } else this.record('observation-baseline', {}, undefined, after);
        this.previous = after;
    }
    clear(): void { this.events = []; this.bytes = 0; this.dropped = 0; this.previous = null; }
    export(): string { return JSON.stringify({ schema: 'hallumina-gameplay-v1', revision: 254, dropped: this.dropped, events: this.events }, null, 2); }
    get count(): number { return this.events.length; }
}
