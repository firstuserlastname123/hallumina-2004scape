import 'dotenv/config';

export type BotLogLevel = 'debug' | 'info' | 'warn' | 'error';
const priorities = { debug: 10, info: 20, warn: 30, error: 40, off: Infinity };

function integer(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return value?.trim() && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

/** Tick-based, bounded logging. Counters record events even when output is filtered. */
export class BotLogger {
    tick = 0;
    readonly counts: Record<string, number> = {};
    filtered = 0;
    suppressed = 0;
    private readonly recent = new Map<string, { tick: number; suppressed: number }>();

    constructor(
        readonly level: keyof typeof priorities = 'info',
        readonly rateTicks = 100,
        private readonly sink: (line: string) => void = line => console.log(line)
    ) {}

    count(key: string): void {
        this.counts[key] = (this.counts[key] ?? 0) + 1;
    }

    event(level: BotLogLevel, source: string, key: string, message: string, rateLimited = true): void {
        this.count(key);
        if (priorities[level] < priorities[this.level]) { this.filtered++; return; }
        if (!rateLimited || this.rateTicks === 0) {
            this.sink(`[Bots:${level}][${source}][t${this.tick}] ${message}`);
            return;
        }
        const id = `${source}:${key}`;
        const previous = this.recent.get(id);
        if (previous && this.tick - previous.tick < this.rateTicks) {
            previous.suppressed++;
            this.suppressed++;
            return;
        }
        // A hard cap also bounds memory when dynamic targets or bot names change.
        if (this.recent.size >= 4096) this.recent.delete(this.recent.keys().next().value!);
        this.recent.set(id, { tick: this.tick, suppressed: 0 });
        const repeated = previous?.suppressed ? ` (${previous.suppressed} repeats suppressed)` : '';
        this.sink(`[Bots:${level}][${source}][t${this.tick}] ${message}${repeated}`);
    }

    debug(...values: unknown[]): void {
        const message = values.map(String).join(' ');
        // Legacy task diagnostics retain their task/bot prefix, but share the same policy.
        const source = message.match(/^(?:\[[^\]]+\]){1,2}/)?.[0] ?? 'tasks';
        if (/timeout/i.test(message)) this.count('timeouts');
        this.event('debug', source, 'detail', message);
    }
}

const configured = (process.env.BOT_LOG_LEVEL ?? 'info').trim().toLowerCase();
export const BotLog = new BotLogger(Object.hasOwn(priorities, configured) ? configured as keyof typeof priorities : 'info', integer(process.env.BOT_LOG_RATE_TICKS, 100));
export const BOT_SUMMARY_TICKS = integer(process.env.BOT_LOG_SUMMARY_TICKS, 100);
export const BOT_LOG_DETAILS = process.env.BOT_LOG_DETAILS === 'true';
