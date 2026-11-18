/** Shared existing r254 navigation polygon and boundary-inclusive test. */
export const KARAMJA_POLYGON: number[][] = [
    [2672, 3205],
    [2709, 3246],
    [2807, 3257],
    [2784, 3325],
    [2885, 3323],
    [2882, 3217],
    [2962, 3176],
    [2961, 3113],
    [3024, 3070],
    [3008, 2857],
    [2729, 2852],
    [2727, 3103]
];

export function isInside(arr: number[][], x: number, z: number): boolean {
    const n = arr.length;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const [x1, z1] = arr[i];
        const [x2, z2] = arr[j];

        // Point lies on the current edge
        if (onSegment(x1, z1, x2, z2, x, z)) return true;

        // Check whether the horizontal ray from (x, z)
        // intersects the current edge
        const intersect = z1 > z !== z2 > z && x < ((x2 - x1) * (z - z1)) / (z2 - z1) + x1;

        if (intersect) inside = !inside;
    }
    return inside;
}

function onSegment(x1: number, z1: number, x2: number, z2: number, x: number, z: number): boolean {
    const c = (x - x1) * (z2 - z1) - (z - z1) * (x2 - x1);
    if (c !== 0) return false;

    return Math.min(x1, x2) <= x && x <= Math.max(x1, x2) && Math.min(z1, z2) <= z && z <= Math.max(z1, z2);
}
