/** Per-destination retry budget. Only observed progress resets failures. */
export class BotRouteRetry {
    private destination = '';
    private target: { x: number; z: number; level: number } | null = null;
    private bestDistance = Infinity;
    private retryAt = 0;
    private progressTick = 0;
    failures = 0;

    request(x: number, z: number, level: number, destX: number, destZ: number, destLevel: number, tick = 0): boolean {
        const key = `${destX},${destZ},${destLevel}`;
        const changed = key !== this.destination;
        if (changed) { this.reset(); this.destination = key; this.target = { x: destX, z: destZ, level: destLevel }; this.progressTick = tick; }
        this.noteProgress(x, z, level, tick);
        return changed;
    }

    /** Called every bot tick so activity time cannot become a navigation stall. */
    observe(x: number, z: number, level: number, walking: boolean, tick: number): void {
        if (!walking) { this.progressTick = tick; return; }
        this.noteProgress(x, z, level, tick);
    }

    private noteProgress(x: number, z: number, level: number, tick: number): void {
        if (!this.target) return;
        const distance = level === this.target.level ? Math.max(Math.abs(x - this.target.x), Math.abs(z - this.target.z)) : Infinity;
        if (distance < this.bestDistance - 2 || distance === 0) {
            this.bestDistance = distance;
            this.failures = 0;
            this.retryAt = 0;
            this.progressTick = tick;
        }
    }

    canAttempt(tick: number): boolean { return tick >= this.retryAt; }
    isStalled(tick: number): boolean { return tick - this.progressTick >= 100; }
    get destinationLabel(): string { return this.destination || 'interaction target'; }

    fail(tick: number): boolean {
        this.failures++;
        this.progressTick = tick;
        this.retryAt = tick + Math.min(40, 2 ** this.failures * 2);
        return this.failures >= 4;
    }

    reset(): void {
        this.destination = '';
        this.target = null;
        this.bestDistance = Infinity;
        this.retryAt = 0;
        this.failures = 0;
        this.progressTick = 0;
    }
}
