export interface Tile { x: number; z: number; level: number }
export interface Item { slot: number; id: number; name: string; count: number; options: (string | null)[] }
export interface SceneObject extends Tile { id: number; name: string; options: (string | null)[]; width: number; length: number }
export interface Npc extends Tile { index: number; name: string; options: (string | null)[] }
export interface Interface { id: number; text: string; options: (string | null)[]; buttonType: number }
export interface Observation {
    version: 1; sequence: number; at: number; account: string | null; ready: boolean; position: Tile | null;
    inventory: Item[]; equipment: Item[]; skills: { level: number; base: number; xp: number }[];
    objects: SceneObject[]; npcs: Npc[]; groundItems: (Tile & Item)[]; interfaces: Interface[];
    /** Only varps referenced by the native quest journal's component scripts. */
    quests: Record<number, number>; bank: Item[] | null; animation: number; moving: boolean; health: number;
}
export type Action =
    | { kind: 'walk'; tile: Tile }
    | { kind: 'object'; id: number; tile: Tile; option: string }
    | { kind: 'npc'; index: number; option: string }
    | { kind: 'inventory'; slot: number; id: number; option: string }
    | { kind: 'dialogue'; component: number }
    | { kind: 'deposit'; slot: number; id: number }
    | { kind: 'close-bank' };
export type ActionState = 'dispatched' | 'pending' | 'success' | 'blocked' | 'interrupted' | 'timeout';
export interface ActionResult { id: number; action: Action; state: ActionState; reason: string; before: number; after: number }
export interface ActionRequest { action: Action; sequence: number; account: string; deadline: number }
export interface GamePort {
    observe(): Observation;
    /** Returns a reachable approach tile using native scene collision, without issuing a click. */
    approach(target: Tile, width?: number, length?: number): Tile | null;
    dispatch(request: ActionRequest): { accepted: boolean; reason: string };
    /** Reflect observed progress in a native input-idle clock while the runner owns control. */
    acknowledgeActivity?(sequence: number, account: string): void;
    onManualCommand(listener: (action: Record<string, unknown>) => void): () => void;
    dispose(): void;
}
export const total = (items: Item[], id: number): number => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
export const distance = (a: Tile, b: Tile): number => a.level === b.level ? Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) : Infinity;
