/** Optional browser smoke test. Run from an assembled engine; see the report. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import forge from 'node-forge';
import { hashSync } from 'bcrypt-ts';

const engine = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const require = createRequire(import.meta.url);
// Optional tooling lives outside the production dependency graph.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r254-personal-bot-'));
const resultPath = process.env.PERSONAL_BOT_RESULTS;
if (!resultPath) throw new Error('Set PERSONAL_BOT_RESULTS to an absolute output JSON path');
assert.ok(path.isAbsolute(resultPath));
const results = { revision: 254, normalTickMs: 600, xprate: 1, steps: [], browserErrors: [] };
let browser, child, log;
const snapshots = {};

async function until(check, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await delay(200);
    }
    throw new Error(`Timed out: ${label}`);
}
async function stop() {
    if (!child || child.exitCode !== null) return;
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    const watchdog = setTimeout(() => child?.kill('SIGKILL'), 30_000);
    const [code, signal] = await exit;
    clearTimeout(watchdog);
    assert.equal(signal, null, 'World must shut down gracefully');
    assert.equal(code, 0);
}
try {
    fs.mkdirSync(path.join(temp, 'data'));
    for (const name of ['src', 'tools', 'node_modules', 'package.json', 'tsconfig.json', 'view', 'public']) {
        fs.symlinkSync(path.join(engine, name), path.join(temp, name));
    }
    for (const name of ['raw', 'config', 'pack', 'bot']) fs.symlinkSync(path.join(engine, 'data', name), path.join(temp, 'data', name));
    fs.writeFileSync(path.join(temp, '.personal-bot-disposable'), '');
    const db = new DatabaseSync(path.join(temp, 'db.sqlite'));
    for (const dir of fs.readdirSync(path.join(engine, 'prisma/singleworld/migrations')).sort()) {
        const sql = path.join(engine, 'prisma/singleworld/migrations', dir, 'migration.sql');
        if (fs.existsSync(sql)) db.exec(fs.readFileSync(sql, 'utf8'));
    }
    // Register disposable, non-staff accounts. Character saves are still empty;
    // all tutorial state, equipment, items and XP come from native gameplay.
    const passwordHash = hashSync('disposable-test', 4);
    for (const username of ['pr7bot', 'pr7human']) db.prepare('INSERT INTO account (username, password) VALUES (?, ?)').run(username, passwordHash);
    db.close();
    // public.pem can be stale in assembled installations. Derive only the public
    // components from the key the native login listener actually uses.
    const key = forge.pki.privateKeyFromPem(fs.readFileSync(path.join(engine, 'data/config/private.pem'), 'utf8'));
    const webclient = path.resolve(engine, '../webclient');
    const define = { 'process.env.SECURE_ORIGIN': JSON.stringify('127.0.0.1'), 'process.env.LOGIN_RSAN': JSON.stringify(key.n.toString(10)),
        'process.env.LOGIN_RSAE': JSON.stringify(key.e.toString(10)), 'process.env.BUILD_TIME': JSON.stringify('r254-personal-experiment') };
    for (const [entry, output] of [['experiments/personal-client.ts', 'experiment.js'], ['src/client/ClientEntry.ts', 'native.js']]) {
        await build({ entryPoints: [path.join(webclient, entry)], bundle: true, format: 'esm', target: 'es2022',
            outfile: path.join(temp, output), tsconfig: path.join(webclient, 'tsconfig.json'), define,
            alias: { fflate: require.resolve('fflate') } });
    }
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const loginSocket = net.createServer();
    loginSocket.listen(0, '127.0.0.1'); await once(loginSocket, 'listening');
    const loginPort = loginSocket.address().port;
    await new Promise(resolve => loginSocket.close(resolve));
    log = fs.openSync(`${resultPath}.world.log`, 'w');
    const worldEnv = { ...process.env,
        NODE_PROFILE: 'external-framework-test', DB_BACKEND: 'sqlite', NODE_PRODUCTION: 'true', ENGINE_REVISION: '254',
        NODE_XPRATE: '1', NODE_PROGRESSIVE_XP: 'false', LOGIN_SERVER: 'true', FRIEND_SERVER: 'false', LOGGER_SERVER: 'false',
        LOGIN_PORT: String(loginPort), LOGIN_HOST: '127.0.0.1', WEB_PORT: String(port), WEB_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
        BUILD_SRC_DIR: path.resolve(engine, '../content'), BOT_DEBUG_ENABLED: 'false', BOT_LOG_LEVEL: 'off', NODE_FEATURE_GRANDEXCHANGE: 'false'
    };
    async function start() {
        child = spawn(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/experiments/personal-bot-world.ts')], {
            cwd: temp, stdio: ['ignore', log, log], env: worldEnv
        });
        await until(async () => {
            if (child.exitCode !== null) throw new Error(`World exited ${child.exitCode}; see ${resultPath}.world.log`);
            try { return (await fetch(`http://127.0.0.1:${port}/crc`)).ok; } catch { return false; }
        }, 'world startup');
    }
    const observer = () => JSON.parse(fs.readFileSync(path.join(temp, 'observations.json'), 'utf8'));
    await start();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    async function page(experimental) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        const p = await context.newPage();
        p.on('pageerror', error => results.browserErrors.push(error.message));
        p.on('console', msg => { if (msg.type() === 'error') console.error('browser:', msg.text()); });
        await p.route('**/client/client.js*', route => route.fulfill({ path: path.join(temp, experimental ? 'experiment.js' : 'native.js'), contentType: 'application/javascript' }));
        await p.goto(`http://127.0.0.1:${port}/rs2.cgi?lowmem=1${experimental ? '&personalBotExperiment=1' : ''}`);
        return p;
    }
    const personal = await page(true);
    const observe = () => personal.evaluate(() => globalThis.__r254Personal.observe());
    await until(() => personal.evaluate(() => typeof globalThis.__r254Personal !== 'undefined'), 'bridge');
    // Readiness comes from loaded cache/interface state, before issuing login.
    await until(async () => { const s = await observe(); snapshots.latest = s; return s.assetsReady; }, 'native cache loading', 180_000);
    await personal.evaluate(() => globalThis.__r254Personal.login('pr7bot', 'wrong-password'));
    assert.equal((await observe()).ingame, false);
    assert.ok((await observe()).loginMessage.some(m => /Invalid username or password/.test(m)));
    results.wrongPasswordRejected = true;
    await personal.evaluate(() => globalThis.__r254Personal.login('pr7bot', 'disposable-test'));
    await until(async () => { const s = await observe(); snapshots.latest = s; return s.ingame && s.ready; }, 'ordinary account login');
    console.log('ordinary account login passed');
    results.steps.push({ name: 'login', state: await observe() });
    // Follow the ordinary production Tutorial Island prerequisites; no skip.
    let guideTalked = false;
    await until(async () => {
        const s = await observe(); snapshots.latest = s;
        if (guideTalked && !s.interfaces.some(b => b.buttonType === 6) && s.interfaces.some(b => b.text?.includes('Interacting with scenery'))) return true;
        const accept = s.interfaces.find(b => b.clientCode === 326);
        const next = s.interfaces.find(b => b.buttonType === 6);
        if (accept || next) await personal.evaluate(id => globalThis.__r254Personal.button(id), (accept || next).id);
        else if (!guideTalked) {
            const guide = s.npcs.find(n => n.name === 'RuneScape Guide');
            if (guide) { await personal.evaluate(index => globalThis.__r254Personal.npc(index, 'Talk-to'), guide.index); guideTalked = true; }
        }
        await delay(800);
        return false;
    }, 'native guide conversation', 90_000);
    const door = (await observe()).locs.find(l => l.x === 3098 && l.z === 3107 && l.ops?.includes('Open'));
    assert.ok(door, 'Native tutorial door must be visible');
    await personal.evaluate(l => globalThis.__r254Personal.loc(l.id, l.x, l.z, 'Open'), door);
    await delay(2400);
    console.log('native guide and door passed');
    results.steps.push({ name: 'native-tutorial-door', state: await observe() });
    const human = await page(false);
    // Human path uses the normal bundle and physical mouse/keyboard events.
    assert.equal(await human.evaluate(() => typeof globalThis.__r254Personal), 'undefined');
    await human.waitForFunction(() => globalThis.__gameClient?.viewportScanline && !globalThis.__gameClient.errorHost && !globalThis.__gameClient.errorLoading,
        null, { timeout: 180_000 });
    const canvas = human.locator('canvas#canvas');
    await canvas.click({ position: { x: 462, y: 291 } });
    await human.waitForFunction(() => globalThis.__gameClient.loginscreen === 2);
    await human.keyboard.type('pr7human', { delay: 30 }); await human.keyboard.press('Tab');
    await human.keyboard.type('disposable-test', { delay: 30 });
    await human.waitForFunction(() => globalThis.__gameClient.loginUser === 'pr7human' && globalThis.__gameClient.loginPass.length === 15);
    await canvas.click({ position: { x: 302, y: 321 } });
    await until(() => observer().players.some(p => p.name === 'pr7human'), 'normal client login');
    await human.waitForFunction(() => globalThis.__gameClient?.sceneState === 2);
    await human.waitForFunction(() => globalThis.__gameClient.mainModalId === 3559);
    // Native menus are assembled on a frame after the mouse moves.
    await canvas.hover({ position: { x: 260, y: 285 } });
    await delay(150);
    await canvas.click({ position: { x: 260, y: 285 } });
    await until(() => observer().players.find(p => p.name === 'pr7human')?.tutorial === 1, 'human mouse accepts native character design');
    const humanBefore = observer().players.find(p => p.name === 'pr7human').position;
    await canvas.click({ position: { x: 653, y: 80 } });
    await until(() => { const p = observer().players.find(p => p.name === 'pr7human');
        return p && (p.position.x !== humanBefore.x || p.position.z !== humanBefore.z); }, 'human minimap movement');
    results.humanMovement = { before: humanBefore, after: observer().players.find(p => p.name === 'pr7human').position };
    results.humanBundleHasBridge = false;
    const destination = { x: 3104, z: 3098 };
    assert.equal(await personal.evaluate(d => globalThis.__r254Personal.walk(d.x, d.z), destination), true);
    await until(async () => { const s = await observe(); return s.position.x === destination.x && s.position.z === destination.z; }, 'native walk');
    results.steps.push({ name: 'walk', destination, state: await observe() });
    let survivalTalked = false;
    await until(async () => {
        const s = await observe(); snapshots.latest = s;
        if (survivalTalked && s.interfaces.some(b => b.text?.includes('Viewing the items'))) return true;
        const next = s.interfaces.find(b => b.buttonType === 6);
        if (next) await personal.evaluate(id => globalThis.__r254Personal.button(id), next.id);
        else if (!survivalTalked) {
            const guide = s.npcs.find(n => /Survival/.test(n.name));
            if (guide) { await personal.evaluate(index => globalThis.__r254Personal.npc(index, 'Talk-to'), guide.index); survivalTalked = true; }
        }
        await delay(800); return false;
    }, 'survival guide conversation');
    await personal.locator('canvas#canvas').click({ position: { x: 642, y: 186 } });
    await until(async () => (await observe()).inventory.some(i => /Bronze (axe|hatchet)/i.test(i.name)), 'native tutorial inventory reward');
    const before = await observe();
    const tree = before.locs.filter(l => l.name === 'Tree' && l.ops.includes('Chop down'))
        .sort((a, b) => Math.max(Math.abs(a.x - before.position.x), Math.abs(a.z - before.position.z)) - Math.max(Math.abs(b.x - before.position.x), Math.abs(b.z - before.position.z)))[0];
    assert.ok(tree, 'An ordinary native tree must be visible');
    await personal.evaluate(l => globalThis.__r254Personal.loc(l.id, l.x, l.z, 'Chop down'), tree);
    await until(async () => { const s = await observe(); snapshots.latest = s;
        return s.xp[8] > before.xp[8] && s.inventory.some(i => i.name === 'Logs');
    }, 'native logs and woodcutting XP', 90_000);
    console.log('native woodcutting passed');
    results.steps.push({ name: 'woodcutting', before, after: await observe(), tree });
    await until(() => observer().coexistTicks > 5, '100 bots and both ordinary clients');
    await until(() => observer().players.find(p => p.name === 'pr7bot')?.tutorial === 40, 'native activity state observed');
    await until(() => observer().settled.ticks >= 100, '100 settled coexistence ticks', 90_000);
    results.concurrent = observer();
    await personal.evaluate(() => globalThis.__r254Personal.logout());
    await until(async () => !(await observe()).ingame, 'native logout');
    await until(() => !observer().players.some(p => p.name === 'pr7bot'), 'logout admission released');
    results.saves = fs.readdirSync(path.join(temp, 'data/players/external-framework-test'));
    await human.context().close(); await personal.context().close();
    await stop();
    results.beforeRestart = observer();
    const verification = spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/experiments/personal-bot-world.ts'), '--verify-saves'],
        { cwd: temp, env: worldEnv, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(verification.error);
    assert.equal(verification.status, 0, verification.stdout + verification.stderr);
    assert.match(verification.stdout, /verified-save-crcs 102/);
    results.verifiedSaveCrcs = 102;
    await start();
    const reloaded = await page(true);
    await until(() => reloaded.evaluate(() => typeof globalThis.__r254Personal !== 'undefined'), 'reload bridge');
    await until(async () => (await reloaded.evaluate(() => globalThis.__r254Personal.observe())).assetsReady, 'reload cache loading', 180_000);
    await reloaded.evaluate(() => globalThis.__r254Personal.login('pr7bot', 'disposable-test'));
    const restored = await until(async () => { const s = await reloaded.evaluate(() => globalThis.__r254Personal.observe());
        return s.ingame && s.ready && s.inventory.length && s; }, 'reload login');
    const earned = results.steps.find(s => s.name === 'woodcutting').after;
    assert.deepEqual(restored.xp, earned.xp);
    assert.deepEqual(restored.inventory, earned.inventory);
    assert.deepEqual(restored.position, earned.position);
    const restoredPlayer = await until(() => observer().players.find(p => p.name === 'pr7bot'), 'restored native player');
    assert.equal(restoredPlayer.tutorial, 40);
    assert.equal(restoredPlayer.isBot, false);
    results.restoredTutorial = restoredPlayer.tutorial;
    results.steps.push({ name: 'restart-reload', state: restored });
    assert.equal(observer().minBots, 100);
    assert.equal(results.browserErrors.length, 0);
    const checkDb = new DatabaseSync(path.join(temp, 'db.sqlite'), { readOnly: true });
    results.database = { quickCheck: checkDb.prepare('PRAGMA quick_check').get(), accounts: checkDb.prepare('SELECT COUNT(*) AS count FROM account').get(),
        ordinary: checkDb.prepare("SELECT username, password != '!bot' AS ordinary FROM account WHERE username IN ('pr7bot','pr7human')").all() };
    checkDb.close();
    assert.equal(results.database.accounts.count, 102);
    assert.equal(results.database.ordinary.length, 2);
    assert.ok(results.database.ordinary.every(account => account.ordinary === 1));
    results.passed = true;
} catch (error) {
    results.passed = false; results.error = error.stack; results.debug = snapshots;
    for (const [i, p] of (browser?.contexts().flatMap(c => c.pages()) ?? []).entries()) await p.screenshot({ path: `${resultPath}.${i}.png` }).catch(() => {});
    throw error;
} finally {
    await browser?.close();
    try { await stop(); } finally {
        if (log !== undefined) fs.closeSync(log);
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
