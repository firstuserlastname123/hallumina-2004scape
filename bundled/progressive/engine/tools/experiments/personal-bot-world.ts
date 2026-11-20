/** Read-only observations for the disposable browser experiment; no gameplay commands. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import World from '#/engine/World.js';
import Environment from '#/util/Environment.js';
import InvType from '#/cache/config/InvType.js';
import VarPlayerType from '#/cache/config/VarPlayerType.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import Packet from '#/io/Packet.js';
import LoginServer from '#/server/login/LoginServer.js';
import { startWeb } from '#/web.js';

assert.equal(Environment.NODE_PROFILE, 'external-framework-test');
assert.equal(Environment.ENGINE_REVISION, 254);
assert.equal(Environment.NODE_XPRATE, 1);
assert.equal(Environment.NODE_PROGRESSIVE_XP, false);
assert.ok(fs.existsSync('.personal-bot-disposable'));
if (process.argv.includes('--verify-saves')) {
    const directory = `data/players/${Environment.NODE_PROFILE}`;
    const files = fs.readdirSync(directory).filter(name => name.endsWith('.sav'));
    assert.equal(files.length, 102);
    for (const name of files) assert.equal(PlayerLoading.verify(new Packet(fs.readFileSync(`${directory}/${name}`))), true, name);
    console.log(`verified-save-crcs ${files.length}`);
    process.exit(0);
}
assert.equal(Environment.LOGIN_SERVER, true);
const loginServer = new LoginServer();
const listener = (loginServer as unknown as { server: import('ws').WebSocketServer }).server;
if (!listener.address()) await once(listener, 'listening');
const durations: number[] = [];
const settledDurations: number[] = [];
let minBots = 100, coexistTicks = 0, stopping = false;
const cycle = World.cycle.bind(World);
World.cycle = () => {
    const start = performance.now();
    cycle();
    const duration = performance.now() - start;
    durations.push(duration);
    const all = [...World.playerLoop.all()];
    if (!stopping && World.currentTick > 5) {
        const bots = all.filter(p => p.is_bot).length;
        minBots = Math.min(minBots, bots);
        const human = all.find(p => p.username === 'pr7human' && !p.is_bot);
        const personal = all.find(p => p.username === 'pr7bot' && !p.is_bot);
        if (bots === 100 && human && personal) {
            coexistTicks++;
            if (coexistTicks >= 10 && human.getVar(VarPlayerType.getId('tutorial')) >= 1 &&
                personal.getVar(VarPlayerType.getId('tutorial')) === 40) settledDurations.push(duration);
        }
    }
};
function observe() {
    const players = [...World.playerLoop.all()];
    const sorted = durations.slice(5).sort((a, b) => a - b);
    const settled = settledDurations.slice().sort((a, b) => a - b);
    return {
        revision: Environment.ENGINE_REVISION, tick: World.currentTick, minBots, coexistTicks,
        bots: players.filter(p => p.is_bot).length,
        timing: { ticks: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
            p95: sorted[Math.floor(sorted.length * .95)] ?? 0, max: sorted.at(-1) ?? 0, over600: sorted.filter(t => t > 600).length },
        settled: { ticks: settled.length, mean: settled.reduce((a, b) => a + b, 0) / (settled.length || 1),
            p95: settled[Math.floor(settled.length * .95)] ?? 0, max: settled.at(-1) ?? 0, over600: settled.filter(t => t > 600).length },
        players: players.filter(p => /^pr7(bot|human)$/.test(p.username)).map(p => ({
            name: p.username, isBot: p.is_bot, position: { x: p.x, z: p.z, level: p.level },
            xp: [...p.stats], tutorial: p.getVar(VarPlayerType.getId('tutorial')),
            inventory: p.getInventory(InvType.INV)!.items.map(item => item && { id: item.id, count: item.count })
        }))
    };
}
const output = () => fs.writeFileSync('observations.json', JSON.stringify(observe(), null, 2));
const timer = setInterval(output, 600);
process.on('exit', output);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    stopping = true; clearInterval(timer); output(); World.rebootTimer(0);
});
await World.start();
await startWeb();
console.log('personal-bot world ready');
