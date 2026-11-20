/** Test-only entry point. The normal bundle never imports this file. */
import { Client as NativeClient } from '../src/client/ClientEntry.js';
import IfType, { ButtonType } from '../src/config/IfType.js';
import LocType from '../src/config/LocType.js';
import ObjType from '../src/config/ObjType.js';
import { MiniMenuAction } from '../src/client/MiniMenuAction.js';

export class Client extends NativeClient {
    constructor(node: number, lowmem: boolean, members: boolean) {
        super(node, lowmem, members);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
            new URLSearchParams(location.search).get('personalBotExperiment') !== '1') return;

        // The experiment deliberately exposes only client-visible state and normal
        // click dispatch. Private field names are revision-specific adapter work.
        const c = this as any;
        const components = () => {
            const ids = new Set<number>();
            const visit = (id: number) => {
                const com = IfType.list[id];
                if (!com || ids.has(id) || com.hide) return;
                ids.add(id);
                for (const child of com.children ?? []) visit(child);
            };
            for (const id of [c.mainModalId, c.chatComId, c.sideModalId, c.mainOverlayId, c.tutComId, ...c.sideOverlayId]) visit(id);
            return [...ids].map(id => IfType.list[id]);
        };
        const dispatch = (action: number, a = 0, b = 0, d = 0) => {
            if (!c.ingame) throw new Error('Not logged in');
            const previous = [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0], c.menuOption[0]];
            try {
                c.menuAction[0] = action; c.menuParamA[0] = a; c.menuParamB[0] = b; c.menuParamC[0] = d; c.menuOption[0] = '';
                c.doAction(0);
            } finally {
                [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0], c.menuOption[0]] = previous;
            }
        };
        const inventory = () => {
            const widget = IfType.list[3214]; // r254 inventory:inv, verified against this cache
            return Array.from(widget?.linkObjType ?? []).flatMap((encoded, slot) => encoded > 0 ? [{
                slot, id: encoded - 1, name: ObjType.list(encoded - 1).name, count: widget.linkObjNumber![slot]
            }] : []);
        };
        const locs = () => {
            if (!c.localPlayer || !c.world || c.sceneState !== 2) return [];
            const results: { id: number; x: number; z: number; typecode: number; name: string | null; ops: (string | null)[] | null }[] = [];
            const px = c.localPlayer.x >> 7, pz = c.localPlayer.z >> 7;
            for (let x = Math.max(1, px - 10); x <= Math.min(102, px + 10); x++) {
                for (let z = Math.max(1, pz - 10); z <= Math.min(102, pz + 10); z++) {
                    for (const code of [c.world.sceneType(c.minusedlevel, x, z), c.world.wallType(c.minusedlevel, x, z)]) {
                        if (!code) continue;
                        const id = (code >> 14) & 0x7fff, type = LocType.list(id);
                        if (type.op?.some(Boolean)) results.push({ id, x: x + c.mapBuildBaseX, z: z + c.mapBuildBaseZ,
                            typecode: code, name: type.name, ops: type.op });
                    }
                }
            }
            return results;
        };
        const api = {
            version: 'r254-experiment-1',
            observe: () => ({
                assetsReady: !!c.viewportScanline && !c.errorLoading && !c.errorHost,
                loading: { message: c.lastProgressMessage, percent: c.lastProgressPercent, error: c.errorMessage, remaining: c.onDemand?.remaining() },
                diagnostic: { loopCycle: c.loopCycle, drawCycle: c.drawCycle, state: c.state, ptype: c.ptype, psize: c.psize, available: c.stream?.available },
                ingame: c.ingame, ready: c.sceneState === 2, loginMessage: [c.loginMes1, c.loginMes2],
                position: c.localPlayer ? { x: c.mapBuildBaseX + (c.localPlayer.x >> 7), z: c.mapBuildBaseZ + (c.localPlayer.z >> 7), level: c.minusedlevel } : null,
                xp: Array.from(c.statXP), inventory: inventory(), locs: locs(),
                npcs: Array.from(c.npcIds.slice(0, c.npcCount) as number[]).flatMap(index => {
                    const n = c.npc[index];
                    return n?.type ? [{ index, name: n.type.name, ops: n.type.op, x: c.mapBuildBaseX + (n.x >> 7), z: c.mapBuildBaseZ + (n.z >> 7) }] : [];
                }),
                interfaces: components().map(com => ({ id: com.id, text: com.text, option: com.buttonText, buttonType: com.buttonType, clientCode: com.clientCode })),
                messages: c.chatText.slice(0, 8)
            }),
            login: async (name: string, password: string) => {
                if (!/^pr7(bot|human)$/.test(name)) throw new Error('Disposable experiment accounts only');
                if (c.ingame) throw new Error('Already logged in');
                await c.login(name, password, false);
            },
            walk: (x: number, z: number) => {
                if (!c.ingame || c.sceneState !== 2 || !Number.isInteger(x) || !Number.isInteger(z)) return false;
                const sx = x - c.mapBuildBaseX, sz = z - c.mapBuildBaseZ;
                if (sx < 1 || sz < 1 || sx > 102 || sz > 102) return false;
                return c.tryMove(c.localPlayer.routeX[0], c.localPlayer.routeZ[0], sx, sz, false, 0, 0, 0, 0, 0, 0);
            },
            npc: (index: number, option: string) => {
                const n = c.npc[index], op = n?.type?.op?.indexOf(option) ?? -1;
                if (op < 0 || op > 4) throw new Error('NPC option unavailable');
                dispatch([MiniMenuAction.OP_NPC1, MiniMenuAction.OP_NPC2, MiniMenuAction.OP_NPC3, MiniMenuAction.OP_NPC4, MiniMenuAction.OP_NPC5][op], index);
            },
            loc: (id: number, x: number, z: number, option: string) => {
                const loc = locs().find(l => l.id === id && l.x === x && l.z === z);
                const op = loc?.ops?.indexOf(option) ?? -1;
                if (!loc || op < 0 || op > 4) throw new Error('Location option unavailable');
                dispatch([MiniMenuAction.OP_LOC1, MiniMenuAction.OP_LOC2, MiniMenuAction.OP_LOC3, MiniMenuAction.OP_LOC4, MiniMenuAction.OP_LOC5][op], loc.typecode, x - c.mapBuildBaseX, z - c.mapBuildBaseZ);
            },
            button: (id: number) => {
                const com = components().find(com => com.id === id);
                if (!com) throw new Error('Interface unavailable');
                if (com.buttonType === ButtonType.BUTTON_CONTINUE) dispatch(MiniMenuAction.PAUSE_BUTTON, 0, 0, id);
                else if (com.buttonType === ButtonType.BUTTON_OK) dispatch(MiniMenuAction.IF_BUTTON, 0, 0, id);
                else throw new Error('Unsupported button');
            },
            logout: () => {
                const button = components().find(com => com.clientCode === 205);
                if (!button) throw new Error('Logout interface unavailable');
                dispatch(MiniMenuAction.IF_BUTTON, 0, 0, button.id);
            }
        };
        Object.defineProperty(globalThis, '__r254Personal', { value: Object.freeze(api), configurable: false });
    }
}
