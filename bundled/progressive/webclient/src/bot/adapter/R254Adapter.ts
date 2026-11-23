import type { Client } from '../../client/Client.js';
import IfType, { ButtonType } from '../../config/IfType.js';
import LocType from '#/config/LocType.js';
import ObjType from '#/config/ObjType.js';
import type ClientPlayer from '#/dash3d/ClientPlayer.js';
import type ClientNpc from '#/dash3d/ClientNpc.js';
import type ClientObj from '#/dash3d/ClientObj.js';
import type World from '#/dash3d/World.js';
import type CollisionMap from '#/dash3d/CollisionMap.js';
import type LinkList from '#/datastruct/LinkList.js';
import { MiniMenuAction as Menu } from '#/client/MiniMenuAction.js';
import type { ActionRequest, GamePort, Item, Observation, SceneObject, Tile } from '../api/Types.js';
import { findApproach } from './collision.js';

/** The only private-client binding. Keep this revision-specific surface out of scripts. */
interface NativeState {
    idleTimer: number;
    ingame: boolean; sceneState: number; localPlayer: ClientPlayer | null; world: World | null;
    mapBuildBaseX: number; mapBuildBaseZ: number; minusedlevel: number;
    mainModalId: number; mainOverlayId: number; sideModalId: number; sideTab: number; chatComId: number; tutComId: number; sideOverlayId: number[];
    statXP: number[]; statEffectiveLevel: number[]; statBaseLevel: number[]; var: number[];
    npc: (ClientNpc | null)[]; npcIds: Int32Array; npcCount: number;
    groundObj: (LinkList<ClientObj> | null)[][][]; collision: (CollisionMap | null)[];
    menuAction: Int32Array; menuParamA: Int32Array; menuParamB: Int32Array; menuParamC: Int32Array; menuOption: string[];
    doAction(index: number): void;
    tryMove(sx: number, sz: number, x: number, z: number, nearest: boolean, width: number, length: number, angle: number, shape: number, force: number, type: number): boolean;
}
const LOC_ACTIONS = [Menu.OP_LOC1, Menu.OP_LOC2, Menu.OP_LOC3, Menu.OP_LOC4, Menu.OP_LOC5];
const NPC_ACTIONS = [Menu.OP_NPC1, Menu.OP_NPC2, Menu.OP_NPC3, Menu.OP_NPC4, Menu.OP_NPC5];
const INV_ACTIONS = [Menu.OP_HELD1, Menu.OP_HELD2, Menu.OP_HELD3, Menu.OP_HELD4, Menu.OP_HELD5];
const BANK_MAIN = 5292, BANK_INVENTORY = 2006, BANK_ITEMS = 5382, INVENTORY = 3214, EQUIPMENT = 1688;

export class R254Adapter implements GamePort {
    private readonly c: NativeState;
    private sequence = 0;
    private last: Observation | null = null;
    private automated = false;
    private actionDepth = 0;
    private activity: { account: string; xp: number[]; tile: Tile | null } | null = null;
    private readonly listeners = new Set<(action: Record<string, unknown>) => void>();
    private readonly originalAction: NativeState['doAction'];
    private readonly originalMove: NativeState['tryMove'];
    constructor(client: Client) {
        this.c = client as unknown as NativeState;
        const c = this.c;
        this.originalAction = c.doAction;
        this.originalMove = c.tryMove;
        c.doAction = index => {
            if (!this.automated) {
                const opcode = c.menuAction[index] % 2000;
                const kind = LOC_ACTIONS.includes(opcode) ? 'object' : NPC_ACTIONS.includes(opcode) ? 'npc' :
                    INV_ACTIONS.includes(opcode) ? 'inventory' : opcode === Menu.PAUSE_BUTTON || opcode === Menu.IF_BUTTON ? 'dialogue' :
                    [Menu.INV_BUTTON1, Menu.INV_BUTTON2, Menu.INV_BUTTON3, Menu.INV_BUTTON4, Menu.INV_BUTTON5].includes(opcode) ? 'interface-inventory' : null;
                if (kind) {
                    const a = c.menuParamA[index], b = c.menuParamB[index], d = c.menuParamC[index];
                    const detail: Record<string, unknown> = { kind, opcode, a, b, c: d };
                    if (kind === 'object') {
                        const type = LocType.list((a >> 14) & 0x7fff);
                        Object.assign(detail, { id: (a >> 14) & 0x7fff, name: type.name, option: type.op?.[LOC_ACTIONS.indexOf(opcode)], tile: { x: b + c.mapBuildBaseX, z: d + c.mapBuildBaseZ, level: c.minusedlevel } });
                    } else if (kind === 'npc') {
                        Object.assign(detail, { index: a, name: c.npc[a]?.type?.name, option: c.npc[a]?.type?.op?.[NPC_ACTIONS.indexOf(opcode)] });
                    } else if (kind === 'inventory') {
                        const type = ObjType.list(a); Object.assign(detail, { id: a, slot: b, name: type.name, option: type.iop?.[INV_ACTIONS.indexOf(opcode)] });
                    } else if (kind === 'dialogue') detail.component = d;
                    this.emit(detail);
                }
            }
            this.actionDepth++;
            try { this.originalAction.call(c, index); } finally { this.actionDepth--; }
        };
        c.tryMove = (...args) => {
            if (!this.automated && !this.actionDepth && (args[10] === 0 || args[10] === 1)) {
                this.emit({ kind: 'walk', tile: { x: args[2] + c.mapBuildBaseX, z: args[3] + c.mapBuildBaseZ, level: c.minusedlevel } });
            }
            return this.originalMove.apply(c, args);
        };
    }
    private emit(action: Record<string, unknown>): void {
        for (const listener of this.listeners) {
            try { listener(action); } catch { console.warn('Personal controller listener failed'); }
        }
    }
    onManualCommand(listener: (action: Record<string, unknown>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    dispose(): void { this.c.doAction = this.originalAction; this.c.tryMove = this.originalMove; this.listeners.clear(); }
    acknowledgeActivity(sequence: number, account: string): void {
        const s = this.last;
        if (!s?.ready || s.sequence !== sequence || s.account !== account || Date.now() - s.at > 1500) return;
        const previous = this.activity;
        if (previous?.account === account && (s.skills.some((skill, i) => skill.xp > (previous.xp[i] ?? skill.xp)) ||
            (s.position && previous.tile && (s.position.x !== previous.tile.x || s.position.z !== previous.tile.z || s.position.level !== previous.tile.level)))) {
            this.c.idleTimer = performance.now();
        }
        this.activity = { account, xp: s.skills.map(skill => skill.xp), tile: s.position };
    }
    private components(): IfType[] {
        const ids = new Set<number>();
        const visit = (id: number): void => {
            const com = IfType.list[id];
            if (!com || ids.has(id) || com.hide) return;
            ids.add(id); for (const child of com.children ?? []) visit(child);
        };
        for (const id of [this.c.mainModalId !== -1 ? this.c.mainModalId : this.c.mainOverlayId,
            this.c.sideModalId !== -1 ? this.c.sideModalId : this.c.sideOverlayId[this.c.sideTab], this.c.chatComId, this.c.tutComId]) visit(id);
        return [...ids].map(id => IfType.list[id]);
    }
    private items(id: number): Item[] {
        const com = IfType.list[id];
        return Array.from(com?.linkObjType ?? []).flatMap((encoded, slot) => {
            if (encoded <= 0) return [];
            const obj = ObjType.list(encoded - 1);
            return [{ slot, id: encoded - 1, name: obj.name ?? 'Unknown', count: com.linkObjNumber?.[slot] ?? 0, options: [...(obj.iop ?? [])] }];
        });
    }
    private objects(): (SceneObject & { code: number })[] {
        const c = this.c, p = c.localPlayer;
        if (!p || !c.world || c.sceneState !== 2) return [];
        const objects: (SceneObject & { code: number })[] = [];
        for (let x = Math.max(1, (p.x >> 7) - 24); x <= Math.min(102, (p.x >> 7) + 24); x++) {
            for (let z = Math.max(1, (p.z >> 7) - 24); z <= Math.min(102, (p.z >> 7) + 24); z++) {
                for (const code of new Set([c.world.sceneType(c.minusedlevel, x, z), c.world.wallType(c.minusedlevel, x, z), c.world.gdType(c.minusedlevel, x, z)])) {
                    if (!code) continue;
                    const id = (code >> 14) & 0x7fff, type = LocType.list(id);
                    if (!type.op?.some(Boolean)) continue;
                    const angle = (c.world.typeCode2(c.minusedlevel, x, z, code) >> 6) & 3;
                    objects.push({ id, x: x + c.mapBuildBaseX, z: z + c.mapBuildBaseZ, level: c.minusedlevel, code,
                        name: type.name ?? 'Unknown', options: [...type.op], width: angle % 2 ? type.length : type.width, length: angle % 2 ? type.width : type.length });
                }
            }
        }
        return objects;
    }
    observe(): Observation {
        const c = this.c, p = c.localPlayer, ready = c.ingame && c.sceneState === 2 && !!p && (c.statBaseLevel[3] ?? 0) > 0;
        const components = c.ingame ? this.components() : [];
        const quests: Record<number, number> = {};
        // Quest-list root 638 is a native r254 interface. Read only its script-referenced varps.
        const visitQuest = (id: number, seen = new Set<number>()): void => {
            const com = IfType.list[id]; if (!com || seen.has(id)) return; seen.add(id);
            for (const script of com.scripts ?? []) if (script?.[0] === 5) quests[script[1]] = c.var[script[1]] ?? 0;
            for (const child of com.children ?? []) visitQuest(child, seen);
        };
        if (ready) visitQuest(638);
        const groundItems: Observation['groundItems'] = [];
        if (ready && p) for (let x = Math.max(1, (p.x >> 7) - 10); x <= Math.min(102, (p.x >> 7) + 10); x++) {
            for (let z = Math.max(1, (p.z >> 7) - 10); z <= Math.min(102, (p.z >> 7) + 10); z++) {
                const list = c.groundObj[c.minusedlevel]?.[x]?.[z];
                for (let obj = list?.head(); obj; obj = list?.next()) {
                    const type = ObjType.list(obj.id);
                    groundItems.push({ slot: -1, id: obj.id, name: type.name ?? 'Unknown', count: obj.count, options: [...(type.op ?? [])], x: x + c.mapBuildBaseX, z: z + c.mapBuildBaseZ, level: c.minusedlevel });
                }
            }
        }
        this.last = { version: 1, sequence: ++this.sequence, at: Date.now(), account: c.ingame ? p?.name?.toLowerCase() ?? null : null, ready,
            position: ready && p ? { x: (p.x >> 7) + c.mapBuildBaseX, z: (p.z >> 7) + c.mapBuildBaseZ, level: c.minusedlevel } : null,
            inventory: ready ? this.items(c.mainModalId === BANK_MAIN ? BANK_INVENTORY : INVENTORY) : [], equipment: ready ? this.items(EQUIPMENT) : [],
            skills: ready ? c.statXP.map((xp, id) => ({ xp, level: c.statEffectiveLevel[id], base: c.statBaseLevel[id] })) : [],
            objects: ready ? this.objects().map(({ code, ...o }) => o) : [],
            npcs: ready ? Array.from(c.npcIds.slice(0, c.npcCount)).flatMap(index => {
                const n = c.npc[index]; return n?.type ? [{ index, name: n.type.name ?? 'Unknown', options: [...(n.type.op ?? [])], x: (n.x >> 7) + c.mapBuildBaseX, z: (n.z >> 7) + c.mapBuildBaseZ, level: c.minusedlevel }] : [];
            }) : [], groundItems, quests, interfaces: components.map(com => ({ id: com.id, text: com.text ?? '', options: [...(com.iop ?? [])], buttonType: com.buttonType })),
            bank: ready && c.mainModalId === BANK_MAIN ? this.items(BANK_ITEMS) : null, animation: p?.primaryAnim ?? -1, moving: (p?.routeLength ?? 0) > 0, health: c.statEffectiveLevel[3] ?? 0 };
        return this.last;
    }
    approach(target: Tile, width = 0, length = 0): Tile | null {
        const c = this.c, p = c.localPlayer, map = c.collision[c.minusedlevel];
        if (!p || !map || target.level !== c.minusedlevel) return null;
        const found = findApproach(map.flags, { x: p.x >> 7, z: p.z >> 7 },
            { x: target.x - c.mapBuildBaseX, z: target.z - c.mapBuildBaseZ }, width, length,
            (x, z, dx, dz, w, h) => map.testLoc(x, z, dx, dz, w, h, 0));
        return found ? { x: found.x + c.mapBuildBaseX, z: found.z + c.mapBuildBaseZ, level: target.level } : null;
    }
    private dispatchMenu(action: number, a = 0, b = 0, d = 0): void {
        const c = this.c, previous = [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0]], option = c.menuOption[0];
        try {
            [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0]] = [action, a, b, d]; c.menuOption[0] = '';
            c.doAction(0);
        } finally { [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0]] = previous; c.menuOption[0] = option; }
    }
    dispatch(request: ActionRequest): { accepted: boolean; reason: string } {
        const s = this.last, c = this.c, a = request.action, now = Date.now();
        const blocked = (reason: string) => ({ accepted: false, reason });
        if (!s || !s.ready || !c.ingame || c.sceneState !== 2 || !c.localPlayer || s.health <= 0) return blocked('Client is not ready');
        if (request.account !== s.account || c.localPlayer.name?.toLowerCase() !== request.account) return blocked('Account changed');
        if (request.sequence !== s.sequence || now - s.at > 1500 || !Number.isFinite(request.deadline) || request.deadline < now || request.deadline > now + 60_000) return blocked('Stale observation or deadline');
        if (!['deposit', 'close-bank', 'dialogue'].includes(a.kind) && (c.mainModalId !== -1 || c.chatComId !== -1)) return blocked('Close the current interface before acting');
        this.automated = true;
        try {
            switch (a.kind) {
                case 'walk': {
                    if (![a.tile.x, a.tile.z, a.tile.level].every(Number.isInteger) || !this.approach(a.tile)) return blocked('No native collision route');
                    if (!c.tryMove(c.localPlayer.routeX[0], c.localPlayer.routeZ[0], a.tile.x - c.mapBuildBaseX, a.tile.z - c.mapBuildBaseZ, false, 0, 0, 0, 0, 0, 0)) return blocked('Movement rejected');
                    break;
                }
                case 'object': {
                    const o = this.objects().find(o => o.id === a.id && o.x === a.tile.x && o.z === a.tile.z && o.level === a.tile.level);
                    const op = o?.options.indexOf(a.option) ?? -1;
                    if (!o || op < 0 || op > 4 || !this.approach(o, o.width, o.length)) return blocked('Object unavailable or unreachable');
                    this.dispatchMenu(LOC_ACTIONS[op], o.code, o.x - c.mapBuildBaseX, o.z - c.mapBuildBaseZ); break;
                }
                case 'npc': {
                    const n = c.npc[a.index], op = n?.type?.op?.indexOf(a.option) ?? -1;
                    if (!n || op < 0 || op > 4 || !this.approach({ x: (n.x >> 7) + c.mapBuildBaseX, z: (n.z >> 7) + c.mapBuildBaseZ, level: c.minusedlevel }, 1, 1)) return blocked('NPC unavailable or unreachable');
                    this.dispatchMenu(NPC_ACTIONS[op], a.index); break;
                }
                case 'inventory': {
                    const item = this.items(INVENTORY).find(i => i.slot === a.slot && i.id === a.id), op = item?.options.indexOf(a.option) ?? -1;
                    if (!item || op < 0 || op > 4) return blocked('Inventory option unavailable');
                    this.dispatchMenu(INV_ACTIONS[op], a.id, a.slot, INVENTORY); break;
                }
                case 'deposit': {
                    // PR #8 supports normal logs only. No arbitrary deposit-all, axe, or equipment disposal.
                    if (c.mainModalId !== BANK_MAIN || a.id !== 1511 || !this.items(BANK_INVENTORY).some(i => i.slot === a.slot && i.id === a.id)) return blocked('Bank/log slot unavailable');
                    this.dispatchMenu(Menu.INV_BUTTON4, a.id, a.slot, BANK_INVENTORY); break;
                }
                case 'close-bank':
                    if (c.mainModalId !== BANK_MAIN) return blocked('Bank is closed');
                    this.dispatchMenu(Menu.CLOSE_BUTTON); break;
                case 'dialogue': {
                    const com = this.components().find(com => com.id === a.component);
                    if (!com || ![ButtonType.BUTTON_CONTINUE, ButtonType.BUTTON_OK].includes(com.buttonType)) return blocked('Dialogue choice unavailable');
                    this.dispatchMenu(com.buttonType === ButtonType.BUTTON_CONTINUE ? Menu.PAUSE_BUTTON : Menu.IF_BUTTON, 0, 0, com.id); break;
                }
                default: return blocked('Unsupported action');
            }
            // A validated automated interaction is input, just like a canvas click.
            // Retain the native idle packet/logout behavior when no actions occur.
            c.idleTimer = performance.now();
            return { accepted: true, reason: 'Native action dispatched; awaiting observation' };
        } finally { this.automated = false; }
    }
}
