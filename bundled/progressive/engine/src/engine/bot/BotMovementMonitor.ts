const HISTORY_SIZE = 16;
const STUCK_THRESHOLD = 10;      // ticks without movement while waypoints active
const EDGE_EXPIRY_TICKS = 100;   // ~60 s before a failed edge is reconsidered

/**
 * Per-bot movement state tracker.  One instance per BotPlayer.
 *
 * Call update() once per tick (at the top of BotPlayer.tick()).
 * Check isStuck() / isOscillating() and call clearWaypoints() + resetStuck()
 * when recovery is needed.
 */
export class BotMovementMonitor {
    // Rolling position history — each entry includes the floor and tile coordinates
    private readonly posHistory: number[] = [];

    // How many consecutive ticks the bot had waypoints but didn't move
    private stuckTicks = 0;

    // Failed edges: key = `${level}_${x}_${z}_${nx}_${nz}`, value = expiry tick
    private readonly failedEdges: Map<string, number> = new Map();

    /**
     * Call at the TOP of each BotPlayer.tick() with the bot's current position.
     *
     * @param x           Current x (already updated by engine movement this tick)
     * @param z           Current z
     * @param hadWaypoints Whether the bot had waypoints at the END of the previous tick
     * @param moved       True if x/z differs from the previous tick
     */
    update(x: number, z: number, hadWaypoints: boolean, moved: boolean, level = 0): void {
        // Idle, skilling, bank dialogs and script delays break navigation history.
        if (!hadWaypoints) {
            this.resetOscillation();
            return;
        }
        if (this.posHistory.length && (this.posHistory[this.posHistory.length - 1] >>> 28) !== level) this.resetOscillation();
        // Update position history
        const packed = (level << 28) | (x << 14) | (z & 0x3fff);
        if (this.posHistory.length >= HISTORY_SIZE) this.posHistory.shift();
        this.posHistory.push(packed);

        // Stuck tracking: only count when the bot is actively trying to walk
        if (hadWaypoints) {
            if (moved) {
                this.stuckTicks = 0;
            } else {
                this.stuckTicks++;
            }
        } else {
            this.stuckTicks = 0;
        }
    }

    /** True if the bot has been trying to walk without making progress for too long. */
    isStuck(): boolean {
        return this.stuckTicks >= STUCK_THRESHOLD;
    }

    /** Consecutive ticks the bot has had waypoints but hasn't moved — for debug/observability only. */
    getStuckTicks(): number {
        return this.stuckTicks;
    }

    /**
     * True if the recent position history shows a repeating cycle.
     * Detects A→B→A→B (period 2) and A→B→C→A→B→C (period 3) patterns.
     */
    isOscillating(): boolean {
        const h = this.posHistory;
        const len = h.length;
        if (len < 6) return false;
        for (const period of [2, 3]) {
            if (len < period * 3) continue;
            const cycle = h.slice(-period);
            // Stationary walking attempts belong to isStuck(), with its longer grace.
            if (new Set(cycle).size < 2) continue;
            let matches = true;
            for (let i = len - period * 3; i < len - period; i++) {
                if (h[i] !== h[i + period]) { matches = false; break; }
            }
            if (matches) return true;
        }

        return false;
    }

    /** Reset the stuck counter after applying recovery. */
    resetStuck(): void {
        this.resetOscillation();
    }

    /** Reset the position history after applying oscillation recovery. */
    resetOscillation(): void {
        this.posHistory.length = 0;
        this.stuckTicks = 0;
    }

    // ── Failed-edge cache ─────────────────────────────────────────────────────

    /**
     * Record that a step from (x,z) → (nx,nz) failed at currentTick.
     * The edge is remembered for EDGE_EXPIRY_TICKS before being reconsidered
     * (so dynamic objects like doors can reopen).
     */
    addFailedEdge(level: number, x: number, z: number, nx: number, nz: number, currentTick: number): void {
        const key = `${level}_${x}_${z}_${nx}_${nz}`;
        this.failedEdges.set(key, currentTick + EDGE_EXPIRY_TICKS);

        // Prune expired entries to keep the map bounded
        if (this.failedEdges.size > 64) {
            for (const [k, expiry] of this.failedEdges) {
                if (currentTick >= expiry) this.failedEdges.delete(k);
            }
            while (this.failedEdges.size > 64) this.failedEdges.delete(this.failedEdges.keys().next().value!);
        }
    }

    /** True if this edge was recently recorded as failed and hasn't expired. */
    isEdgeFailed(level: number, x: number, z: number, nx: number, nz: number, currentTick: number): boolean {
        const key = `${level}_${x}_${z}_${nx}_${nz}`;
        const expiry = this.failedEdges.get(key);
        if (expiry === undefined) return false;
        if (currentTick >= expiry) {
            this.failedEdges.delete(key);
            return false;
        }
        return true;
    }

    /** Full reset — call when the bot changes destination or task. */
    reset(): void {
        this.posHistory.length = 0;
        this.stuckTicks = 0;
        this.failedEdges.clear();
    }
}
