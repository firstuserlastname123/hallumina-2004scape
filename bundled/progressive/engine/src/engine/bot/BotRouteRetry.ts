// Compare against a stable anchor, not the preceding randomized request.
const DESTINATION_JITTER_TILES = 4;

/** Per-task retry budget. Retargeting never substitutes for observed progress. */
export class BotRouteRetry {
    private destination = '';
    private target: { x: number; z: number; level: number } | null = null;
    private requested: { x: number; z: number; level: number; distance: number } | null = null;
    private bestDistance = Infinity;
    private retryAt = 0;
    private progressTick = 0;
    failures = 0;

    request(x: number, z: number, level: number, destX: number, destZ: number, destLevel: number, tick = 0): boolean {
        // Credit travel toward the previous goal before moving the anchor. A target
        // moving closer to a stationary bot must not replenish its retry budget.
        this.noteProgress(x, z, level, tick);
        const changed = !this.target || this.target.level !== destLevel ||
            Math.max(Math.abs(destX - this.target.x), Math.abs(destZ - this.target.z)) > DESTINATION_JITTER_TILES;
        if (changed) {
            if (!this.target && this.failures === 0) this.progressTick = tick;
            this.target = { x: destX, z: destZ, level: destLevel };
            this.bestDistance = this.distance(x, z, level);
        }
        this.destination = `${destX},${destZ},${destLevel}`;
        this.requested = { x: destX, z: destZ, level: destLevel,
            distance: level === destLevel ? Math.max(Math.abs(x - destX), Math.abs(z - destZ)) : Infinity };
        return changed;
    }

    /** Called every bot tick so activity time cannot become a navigation stall. */
    observe(x: number, z: number, level: number, walking: boolean, tick: number): void {
        if (!walking) { this.progressTick = tick; return; }
        this.noteProgress(x, z, level, tick);
    }

    private noteProgress(x: number, z: number, level: number, tick: number): void {
        if (!this.target) return;
        const distance = this.distance(x, z, level);
        // A short successful trip within the jitter radius is still progress.
        // Consume that arrival once; merely requesting the current tile is not one.
        const arrived = this.requested && this.requested.distance > 0 && this.requested.level === level &&
            this.requested.x === x && this.requested.z === z;
        if (distance < this.bestDistance - 2 || (distance === 0 && this.bestDistance > 0) || arrived) {
            this.bestDistance = Math.min(this.bestDistance, distance);
            if (arrived) this.requested!.distance = 0;
            this.failures = 0;
            this.retryAt = 0;
            this.progressTick = tick;
        }
    }

    private distance(x: number, z: number, level: number): number {
        return this.target?.level === level ? Math.max(Math.abs(x - this.target.x), Math.abs(z - this.target.z)) : Infinity;
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
        this.requested = null;
        this.bestDistance = Infinity;
        this.retryAt = 0;
        this.failures = 0;
        this.progressTick = 0;
    }
}
