import assert from 'node:assert/strict';
import fs from 'node:fs';
const { default: World } = await import('#/engine/World.js');
const { PlayerLoading } = await import('#/engine/entity/PlayerLoading.js');
const { default: Packet } = await import('#/io/Packet.js');
const { default: ClientSocket } = await import('#/server/ClientSocket.js');
const { default: InvType } = await import('#/cache/config/InvType.js');
const { default: ObjType } = await import('#/cache/config/ObjType.js');
const { default: VarPlayerType } = await import('#/cache/config/VarPlayerType.js');
const { BotManager } = await import('#/engine/bot/BotManager.js');
const { PlayerStat } = await import('#/engine/entity/PlayerStat.js');
await World.start(false, false);
class MemoryClient extends ClientSocket {
    constructor() { super(); this.remoteAddress = '127.0.0.1'; this.state = 1; }
    send(_raw: Uint8Array) {}
    close() { this.state = -1; }
    terminate() { this.close(); }
}
const restoring = process.argv[2] === 'restore';
const client = new MemoryClient();
World.loginRequests.set(client.uuid, client);
const loginThread = (World as any).loginThread;
const login = new Promise<any>(resolve => {
    const listener = (msg: any) => {
        if (msg.type !== 'player_login' || msg.socket !== client.uuid) return;
        loginThread.off('message', listener);
        resolve(msg);
    };
    loginThread.on('message', listener);
});
loginThread.postMessage({ type: 'player_login', username: 'persistman', socket: client.uuid,
    password: 'test', uid: 1, remoteAddress: client.remoteAddress, lowMemory: false, reconnecting: false, hasSave: false });
assert.equal((await login).reply, restoring ? 0 : 4);
const human = [...World.newPlayers].find(p => p.username === 'persistman')!;
assert.ok(human);
BotManager.init(World);
(World as any).processLogins();
const bots = [...World.playerLoop.all()].filter(p => p.is_bot);
assert.ok(bots.length > 0);
const bot = bots.find(p => p.username === 'sk1')!;
assert.ok(bot);
const fishing = VarPlayerType.getId('fishingcompo');
const grandtree = VarPlayerType.getId('grandtree');
const femi = VarPlayerType.getId('femi_help');
const barcrawl = VarPlayerType.getId('barcrawl');
if (!restoring) {
    for (const p of bots) {
        assert.equal(p.getVar(fishing), 0, 'fresh bots must not receive Fishing Contest completion');
        assert.equal(p.getVar(grandtree), 0, 'fresh bots must not receive Grand Tree completion');
        assert.equal(p.getVar(femi), 0, 'fresh bots must use the native Gnome gate interaction');
        assert.equal(p.getVar(barcrawl), 0, 'fresh bots must not receive Barcrawl completion');
    }
}
const varp = VarPlayerType.getId('option_music');
assert.ok(varp >= 0 && VarPlayerType.get(varp).scope === VarPlayerType.SCOPE_PERM);
const coins = ObjType.getId('coins');
assert.ok(coins >= 0);
function state(p: typeof human) {
    return { xp: p.stats[PlayerStat.WOODCUTTING], level: p.baseLevels[PlayerStat.WOODCUTTING], playtime: p.playtime,
        coins: p.invTotal(InvType.INV, coins), bank: p.invTotal(InvType.getId('bank'), coins), varp: p.getVar(varp), fishing: p.getVar(fishing), grandtree: p.getVar(grandtree), femi: p.getVar(femi), barcrawl: p.getVar(barcrawl), x: p.x, z: p.z, plane: p.level };
}
if (restoring) {
    const expected = JSON.parse(fs.readFileSync('expected.json', 'utf8'));
    for (const p of [human, bot]) {
        const actual = state(p);
        assert.ok(actual.playtime >= expected[p.username].playtime && actual.playtime <= expected[p.username].playtime + 1025);
        // Logout scripts can take additional ticks before the final snapshot.
        assert.deepEqual({ ...actual, playtime: 0 }, { ...expected[p.username], playtime: 0 });
    }
    assert.equal(bots.length, expected.botCount);
    for (const p of [human, ...bots]) {
        const raw = fs.readFileSync(`data/players/main/${p.username}.sav`);
        assert.equal(PlayerLoading.verify(new Packet(raw)), true);
    }
    console.log('persistence restart checks passed');
    process.exit(0);
}
for (const p of [human, bot]) {
    p.addXp(PlayerStat.WOODCUTTING, 123450);
    p.invAdd(InvType.INV, coins, 321, false);
    p.invAdd(InvType.getId('bank'), coins, 654, false);
    p.setVar(varp, 1);
    // Represent a completed quest and partial progress from an existing save.
    p.setVar(fishing, 5); p.setVar(grandtree, 7);
    p.playtime = 5678;
    p.x = 3222; p.z = 3218; p.level = 0;
}
// Deliberately fail the first worker write. World must retain the snapshot and
// wait for retry instead of exiting on a false success acknowledgement.
const worker = (World as any).loginThread;
const original = worker.postMessage.bind(worker);
let failed = false;
worker.postMessage = (msg: any) => {
    if (msg.type === 'player_logout' && msg.username === human.username && !failed) {
        failed = true;
        original({ ...msg, save: new Uint8Array([0]) });
    } else original(msg);
};
const response = World.onLoginMessage.bind(World);
World.onLoginMessage = (msg: any) => {
    response(msg);
    if (msg.type === 'player_logout' && msg.username === human.username && !msg.success) {
        assert.equal(World.logoutRequests.has(human.username), true);
        assert.equal(fs.existsSync(`data/players/main/${human.username}.sav`), false);
        // Exercise the existing retry without adding 15 seconds to this test.
        World.logoutRequests.get(human.username)!.lastAttempt = -1;
    }
};
const humanExpected = state(human), botExpected = state(bot);
fs.writeFileSync('expected.json', JSON.stringify({ [human.username]: humanExpected, [bot.username]: botExpected, botCount: bots.length }));
// Use the same signal -> countdown -> World drain as app.ts, without opening
// public game/web ports. All configured bots use their normal logout path.
process.on('SIGTERM', () => { World.rebootTimer(0); World.nextTick = Date.now(); World.cycle(); });
console.log('ready for shutdown signal');
