/** Bounded samples for percentiles; count/mean/max cover the entire reporting window. */
export class BotTickMetrics {
    private samples: number[] = [];
    private count = 0;
    private total = 0;
    private maximum = 0;
    private overruns = 0;

    record(ms: number): void {
        if (this.samples.length >= 600) this.samples[this.count % 600] = ms;
        else this.samples.push(ms);
        this.count++;
        this.total += ms;
        this.maximum = Math.max(this.maximum, ms);
        if (ms > 600) this.overruns++;
    }

    snapshot() {
        const sorted = [...this.samples].sort((a, b) => a - b);
        return { count: this.count, meanMs: this.count ? this.total / this.count : 0,
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, maxMs: this.maximum, over600ms: this.overruns };
    }

    reset(): void {
        this.samples.length = 0;
        this.count = this.total = this.maximum = this.overruns = 0;
    }
}
