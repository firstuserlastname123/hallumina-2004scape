/** Disposable browser test entry only; never included in either production bundle. */
export { Client } from '../src/bot/PersonalClientEntry.js';
import IfType from '../src/config/IfType.js';
import LocType from '../src/config/LocType.js';
import { MiniMenuAction as M } from '../src/client/MiniMenuAction.js';
// Test setup follows every Tutorial Island requirement through native clicks.
// No item/stat/varp/save writes, admin commands, or tutorial skip are permitted.
const client = () => (globalThis as any).__gameClient;
function dispatch(action: number, a = 0, b = 0, d = 0) {
    const c = client();
    c.idleTimer = performance.now();
    const old = [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0], c.menuOption[0]];
    try { c.menuAction[0] = action; c.menuParamA[0] = a; c.menuParamB[0] = b; c.menuParamC[0] = d; c.menuOption[0] = ''; c.doAction(0); }
    finally { [c.menuAction[0], c.menuParamA[0], c.menuParamB[0], c.menuParamC[0], c.menuOption[0]] = old; }
}
(globalThis as any).__pr8Test = {
    snapshot() {
        const c = client(); if (!c) return null;
        const s = c.personalController.game.observe();
        // Tutorial fires/anvils have no standalone click option, but accept item use.
        if (s.ready) for (let x = Math.max(1, (c.localPlayer.x >> 7) - 24); x < Math.min(103, (c.localPlayer.x >> 7) + 25); x++) {
            for (let z = Math.max(1, (c.localPlayer.z >> 7) - 24); z < Math.min(103, (c.localPlayer.z >> 7) + 25); z++) {
                for (const code of [c.world.sceneType(c.minusedlevel, x, z), c.world.wallType(c.minusedlevel, x, z), c.world.gdType(c.minusedlevel, x, z)]) {
                    if (!code) continue;
                    const id = (code >> 14) & 0x7fff, type = LocType.list(id), wx = x + c.mapBuildBaseX, wz = z + c.mapBuildBaseZ;
                    if (!s.objects.some((o: any) => o.id === id && o.x === wx && o.z === wz)) s.objects.push({ id, name: type.name, options: type.op ?? [], x: wx, z: wz, level: c.minusedlevel });
                }
            }
        }
        return { ...s, assetsReady: !!c.viewportScanline, main: c.mainModalId, chat: c.chatComId,
            components: s.interfaces.map((i: any) => ({ ...i, clientCode: IfType.list[i.id].clientCode, label: IfType.list[i.id].buttonText })),
            messages: c.chatText.slice(0, 6), selectedTab: c.sideTab, vars: [...c.var] };
    },
    command(a: any) {
        const c = client(), s = this.snapshot();
        if (a.kind === 'login') { if (!/^pr7(bot|human)$/.test(a.name)) throw new Error('Disposable accounts only'); return c.login(a.name, a.password, false); }
        if (!s.ready) return false;
        c.idleTimer = performance.now();
        if (a.kind === 'walk') return c.tryMove(c.localPlayer.routeX[0], c.localPlayer.routeZ[0], a.x - c.mapBuildBaseX, a.z - c.mapBuildBaseZ, false, 0, 0, 0, 0, 0, 0);
        if (a.kind === 'tab') { c.sideTab = a.tab; c.redrawSidebar = true; c.redrawSideicons = true; return; }
        if (a.kind === 'button') { const com = IfType.list[a.id]; dispatch(com.buttonType === 6 ? M.PAUSE_BUTTON : com.buttonType === 4 ? M.TOGGLE_BUTTON : M.IF_BUTTON, 0, 0, a.id); return; }
        if (a.kind === 'close') { dispatch(M.CLOSE_BUTTON); return; }
        if (a.kind === 'npc') { dispatch([M.OP_NPC1, M.OP_NPC2, M.OP_NPC3, M.OP_NPC4, M.OP_NPC5][a.op ?? 0], a.index); return; }
        if (a.kind === 'object' || a.kind === 'use-object') {
            const o = s.objects.find((o: any) => o.id === a.id && o.x === a.x && o.z === a.z); if (!o) return false;
            const x = o.x - c.mapBuildBaseX, z = o.z - c.mapBuildBaseZ, code = c.world.sceneType(c.minusedlevel, x, z) || c.world.wallType(c.minusedlevel, x, z) || c.world.gdType(c.minusedlevel, x, z);
            if (a.kind === 'use-object') { const item = s.inventory.find((i: any) => i.slot === a.slot); dispatch(M.USEHELD_START, item.id, item.slot, 3214); dispatch(M.USEHELD_ONLOC, code, x, z); }
            else dispatch([M.OP_LOC1, M.OP_LOC2, M.OP_LOC3, M.OP_LOC4, M.OP_LOC5][a.op ?? 0], code, x, z);
            return;
        }
        if (a.kind === 'item') { const item = s.inventory.find((i: any) => i.slot === a.slot); dispatch([M.OP_HELD1, M.OP_HELD2, M.OP_HELD3, M.OP_HELD4, M.OP_HELD5][a.op ?? 0], item.id, item.slot, 3214); return; }
        if (a.kind === 'use-items') {
            const first = s.inventory.find((i: any) => i.slot === a.first), second = s.inventory.find((i: any) => i.slot === a.second);
            dispatch(M.USEHELD_START, first.id, first.slot, 3214); dispatch(M.USEHELD_ONHELD, second.id, second.slot, 3214); return;
        }
        if (a.kind === 'smith') { dispatch(M.INV_BUTTON1, a.id, a.slot, a.component); return; }
        if (a.kind === 'cast') { dispatch(M.TGT_BUTTON, 0, 0, a.component); dispatch(M.TGT_NPC, a.index); return; }
        if (a.kind === 'deposit-test-item') { dispatch(M.INV_BUTTON4, a.id, a.slot, 2006); return; }
        throw new Error('Unsupported test setup click');
    }
};
