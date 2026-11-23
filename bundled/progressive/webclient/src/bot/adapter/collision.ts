/** Conservative four-direction BFS over the native r254 collision flags. No world coordinates or synthetic routes. */
export function findApproach(flags: Int32Array, start: { x: number; z: number }, goal: { x: number; z: number }, width = 0, length = 0,
    testLoc: (x: number, z: number, dx: number, dz: number, w: number, h: number) => boolean = () => false): { x: number; z: number } | null {
    if (![start.x, start.z, goal.x, goal.z].every(n => Number.isInteger(n) && n > 0 && n < 103)) return null;
    const seen = new Uint8Array(104 * 104), queue = new Int32Array(104 * 104);
    let read = 0, write = 0;
    const index = (x: number, z: number) => x * 104 + z;
    queue[write++] = index(start.x, start.z); seen[queue[0]] = 1;
    while (read < write) {
        const cell = queue[read++], x = Math.floor(cell / 104), z = cell % 104;
        if (width && length ? testLoc(x, z, goal.x, goal.z, width, length) : x === goal.x && z === goal.z) return { x, z };
        for (const [dx, dz, mask] of [[-1, 0, 0x280108], [1, 0, 0x280180], [0, -1, 0x280102], [0, 1, 0x280120]]) {
            const nx = x + dx, nz = z + dz, i = index(nx, nz);
            if (nx > 0 && nz > 0 && nx < 103 && nz < 103 && !seen[i] && !(flags[i] & mask)) { seen[i] = 1; queue[write++] = i; }
        }
    }
    return null;
}
