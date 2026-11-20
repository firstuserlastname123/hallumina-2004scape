/** Bounded fallback over the live player-step rules when a native route is blocked. */
export function findLocalRoute(level: number, srcX: number, srcZ: number, destX: number, destZ: number,
    canStep: (x: number, z: number, nx: number, nz: number) => boolean,
    reached: (x: number, z: number) => boolean, radius = 0): Uint32Array | null {
    if (Math.max(Math.abs(destX - srcX), Math.abs(destZ - srcZ)) > 60) return null;
    type Node = { x: number; z: number; cost: number; score: number; parent: Node | null };
    const heap: Node[] = [];
    const best = new Map<number, number>();
    const key = (x: number, z: number) => (x << 14) | z;
    const push = (node: Node) => {
        let i = heap.length;
        heap.push(node);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].score <= node.score) break;
            heap[i] = heap[parent]; i = parent;
        }
        heap[i] = node;
    };
    const pop = (): Node => {
        const node = heap[0], tail = heap.pop()!;
        if (heap.length) {
            let i = 0;
            while (i * 2 + 1 < heap.length) {
                let child = i * 2 + 1;
                if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++;
                if (heap[child].score >= tail.score) break;
                heap[i] = heap[child]; i = child;
            }
            heap[i] = tail;
        }
        return node;
    };
    const heuristic = (x: number, z: number) => Math.max(0, Math.max(Math.abs(destX - x), Math.abs(destZ - z)) - radius);
    push({ x: srcX, z: srcZ, cost: 0, score: heuristic(srcX, srcZ), parent: null });
    best.set(key(srcX, srcZ), 0);
    let expanded = 0;
    while (heap.length && expanded < 4096) {
        const node = pop();
        if (node.cost !== best.get(key(node.x, node.z))) continue;
        expanded++;
        if (reached(node.x, node.z)) {
            const tiles: Node[] = [];
            for (let next: Node | null = node; next?.parent; next = next.parent) tiles.push(next);
            tiles.reverse();
            const turns: number[] = [];
            for (let i = 0; i < tiles.length; i++) {
                const tile = tiles[i], next = tiles[i + 1], previous = tile.parent!;
                if (!next || next.x - tile.x !== tile.x - previous.x || next.z - tile.z !== tile.z - previous.z) {
                    turns.push((level << 28) | (tile.x << 14) | tile.z);
                }
            }
            return Uint32Array.from(turns);
        }
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dz) continue;
            const x = node.x + dx, z = node.z + dz;
            if (Math.max(Math.abs(x - srcX), Math.abs(z - srcZ)) > 64) continue;
            const cost = node.cost + 1, id = key(x, z);
            if (cost >= (best.get(id) ?? Infinity) || !canStep(node.x, node.z, x, z)) continue;
            best.set(id, cost);
            push({ x, z, cost, score: cost + heuristic(x, z), parent: node });
        }
    }
    return null;
}
