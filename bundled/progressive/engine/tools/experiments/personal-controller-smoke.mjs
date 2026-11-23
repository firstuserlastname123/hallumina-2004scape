/** Optional browser smoke test. Run from an assembled engine; see the report. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import forge from 'node-forge';
import { hashSync } from 'bcrypt-ts';
import { checkContainerIsolation, runInContainer } from './personal-bot-container.mjs';
import { finishTutorial } from './personal-controller-tutorial.mjs';

const engine = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const require = createRequire(import.meta.url);
const resultPath = process.env.PERSONAL_BOT_RESULTS;
if (!resultPath || !path.isAbsolute(resultPath)) throw new Error('Set PERSONAL_BOT_RESULTS to an absolute output JSON path');
if (process.env.PERSONAL_BOT_CONTAINER !== '1') {
    await runInContainer(engine, resultPath, 'personal-controller-smoke.mjs');
    process.exit(0);
}
const isolation = checkContainerIsolation();
// Optional tooling lives outside the production dependency graph.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'r254-personal-bot-'));
const results = { revision: 254, normalTickMs: 600, xprate: 1, isolation,
    runtime: { node: process.version, controllerInheritedEngineDebug: process.env.NODE_DEBUG }, steps: [], browserErrors: [] };
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
    // The native cache opens files with r+, so packs need a writable private
    // copy too. No mutable data directory links back to the assembled source.
    for (const name of ['raw', 'config', 'pack', 'bot']) fs.cpSync(path.join(engine, 'data', name), path.join(temp, 'data', name), { recursive: true, dereference: true });
    fs.cpSync(path.resolve(engine, '../content'), path.join(temp, 'content'), { recursive: true, dereference: true });
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
    for (const [entry, output] of [['experiments/personal-controller-driver.ts', 'experiment.js'], ['src/client/ClientEntry.ts', 'native.js']]) {
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
        // Match Hallumina's normal launcher: this client sends server-routed movement.
        NODE_CLIENT_ROUTEFINDER: 'false',
        NODE_DEBUG: 'false', NODE_DEBUG_PROFILE: 'false', NODE_DEBUG_SOCKET: 'false', EASY_STARTUP: 'false', BUILD_STARTUP: 'false',
        LOGIN_PORT: String(loginPort), LOGIN_HOST: '127.0.0.1', WEB_PORT: String(port), WEB_ALLOWED_ORIGIN: `http://127.0.0.1:${port}`,
        BUILD_SRC_DIR: path.join(temp, 'content'), BOT_DEBUG_ENABLED: 'false', BOT_LOG_LEVEL: 'off', NODE_FEATURE_GRANDEXCHANGE: 'false'
    };
    function listeningSockets(pid) {
        const inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
            try { const socket = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/); return socket ? [socket[1]] : []; }
            catch { return []; }
        }));
        return ['tcp', 'tcp6'].flatMap(table => fs.readFileSync(`/proc/${pid}/net/${table}`, 'utf8').trim().split('\n').slice(1).flatMap(line => {
            const fields = line.trim().split(/\s+/);
            if (fields[3] !== '0A' || !inodes.has(fields[9])) return [];
            const [hex, port] = fields[1].split(':');
            const address = table === 'tcp' ? hex.match(/../g).reverse().map(byte => parseInt(byte, 16)).join('.') : hex;
            return [{ address, port: parseInt(port, 16), family: table === 'tcp' ? 'IPv4' : 'IPv6' }];
        })).sort((a, b) => a.port - b.port);
    }
    async function verifyIsolation() {
        const listeners = listeningSockets(child.pid);
        assert.deepEqual(listeners.map(s => s.port), [port, loginPort].sort((a, b) => a - b));
        assert.ok(listeners.every(s => s.address === '127.0.0.1' && s.family === 'IPv4'));
        const content = path.join(temp, 'content/scripts/tutorial/configs/tutorial.constant');
        const before = fs.readFileSync(content);
        const probes = [];
        for (const [method, url] of [['GET', '/maped'], ['GET', '/content/scripts/tutorial/configs/tutorial.constant'],
            ['GET', '/data/config/public.pem'], ['PUT', '/content/scripts/tutorial/configs/tutorial.constant'], ['PUT', '/content/pr7-write-probe']]) {
            const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, ...(method === 'PUT' ? { body: 'must not be written' } : {}) });
            assert.equal(response.status, 404, `${method} ${url}`);
            probes.push({ method, url, status: response.status });
        }
        assert.deepEqual(fs.readFileSync(content), before);
        assert.equal(fs.existsSync(path.join(temp, 'content/pr7-write-probe')), false);
        results.isolation.runs ??= [];
        results.isolation.runs.push({ listeners, management: 'disabled (exactly two process-owned listening sockets)', probes, copiedContentUnchanged: true });
    }
    async function start() {
        child = spawn(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/experiments/personal-bot-world.ts')], {
            cwd: temp, stdio: ['ignore', log, log], env: worldEnv
        });
        await until(async () => {
            if (child.exitCode !== null) throw new Error(`World exited ${child.exitCode}; see ${resultPath}.world.log`);
            try { return (await fetch(`http://127.0.0.1:${port}/crc`)).ok; } catch { return false; }
        }, 'world startup');
        await verifyIsolation();
    }
    const observer = () => JSON.parse(fs.readFileSync(path.join(temp, 'observations.json'), 'utf8'));
    await start();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    results.runtime.chromium = browser.version();
    async function page(experimental) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        const p = await context.newPage();
        p.on('pageerror', error => results.browserErrors.push(error.message));
        p.on('console', msg => { if (msg.type() === 'error') console.error('browser:', msg.text()); });
        await p.route(/\/client\/(?:personal-client|client)\.js/, route => route.fulfill({ path: path.join(temp, experimental ? 'experiment.js' : 'native.js'), contentType: 'application/javascript' }));
        await p.goto(`http://127.0.0.1:${port}/rs2.cgi?lowmem=1${experimental ? '&personalBot=1' : ''}`);
        return p;
    }
    const personal = await page(true);
    const observe = () => personal.evaluate(() => globalThis.__pr8Test.snapshot());
    const command = a => personal.evaluate(a => globalThis.__pr8Test.command(a), a);
    await personal.waitForFunction(() => globalThis.__pr8Test?.snapshot()?.assetsReady, null, { timeout: 180_000 });
    assert.equal(await personal.locator('.hb-panel').count(), 1);
    assert.equal(await personal.locator('input[type=checkbox]').count(), 1);
    await command({ kind: 'login', name: 'pr7bot', password: 'wrong-password' });
    assert.equal((await observe()).account, null); results.wrongPasswordRejected = true;
    await command({ kind: 'login', name: 'pr7bot', password: 'disposable-test' });
    await until(async () => (await observe())?.ready, 'ordinary native login');
    await personal.getByLabel('Record gameplay events').check();
    const locIds = Object.fromEntries(fs.readFileSync(path.resolve(engine, '../content/pack/loc.pack'), 'utf8').trim().split(/\r?\n/).map(line => { const [id, name] = line.split('='); return [name, Number(id)]; }));
    await finishTutorial(personal, results, locIds, () => observer().players.find(p => p.name === 'pr7bot')?.tutorial);
    console.log('Completed all native Tutorial Island prerequisites');
    results.steps.push({ name: 'legitimate-tutorial-complete', state: await observe() });
    // No save fixture is injected; the same ordinary account travels from Lumbridge.
    for (const [x, z] of [[3220, 3229], [3200, 3230], [3178, 3237], [3156, 3238], [3134, 3244], [3112, 3244], [3102, 3240]]) {
        await until(async () => { const s = await observe(); return s.ready; }, 'travel scene ready');
        await command({ kind: 'walk', x, z });
        await until(async () => { const s = await observe(); return s.position?.x === x && s.position.z === z; }, `native travel ${x},${z}`, 60_000);
    }
    const human = await page(false);
    assert.equal(await human.locator('.hb-panel').count(), 0);
    assert.equal(await human.evaluate(() => typeof globalThis.__pr8Test), 'undefined');
    await human.waitForFunction(() => globalThis.__gameClient?.viewportScanline, null, { timeout: 180_000 });
    const canvas = human.locator('canvas#canvas');
    await canvas.click({ position: { x: 462, y: 291 } });
    await human.keyboard.type('pr7human', { delay: 30 }); await human.keyboard.press('Tab'); await human.keyboard.type('disposable-test', { delay: 30 });
    await canvas.click({ position: { x: 302, y: 321 } });
    await until(() => observer().players.some(p => p.name === 'pr7human'), 'standard client login');
    await human.waitForFunction(() => globalThis.__gameClient.mainModalId === 3559);
    await canvas.hover({ position: { x: 260, y: 285 } }); await delay(150); await canvas.click({ position: { x: 260, y: 285 } });
    await until(() => observer().players.find(p => p.name === 'pr7human')?.tutorial === 1, 'standard character design');
    const humanBefore = observer().players.find(p => p.name === 'pr7human').position;
    await canvas.click({ position: { x: 653, y: 80 } });
    await until(() => { const s = observer().players.find(p => p.name === 'pr7human'); return s && JSON.stringify(s.position) !== JSON.stringify(humanBefore); }, 'standard manual movement');
    results.humanMovement = { before: humanBefore, after: observer().players.find(p => p.name === 'pr7human').position };
    results.automationDisabled = { panelAbsent: true, nativeLogin: true, nativeMovement: true };
    const state = () => personal.evaluate(() => {
        const r = globalThis.__gameClient.personalController;
        return { state: r.state, status: r.status, progress: r.progress, retries: r.retries, logs: r.logs, last: r.lastResult };
    });
    async function startActivity(target) {
        await personal.getByRole('button', { name: 'Start', exact: true }).click();
        await personal.getByLabel('Logs to gather').fill(String(target));
        await personal.getByRole('button', { name: 'Start script', exact: true }).click();
        await until(async () => (await state()).state === 'running', 'script started');
    }
    await startActivity(54);
    await until(async () => (await state()).progress.gathered >= 1, 'first mainland log and XP', 120_000);
    await personal.getByRole('button', { name: 'Pause', exact: true }).click(); assert.equal((await state()).state, 'paused');
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    await personal.locator('canvas#canvas').click({ position: { x: 260, y: 200 } });
    assert.equal((await state()).state, 'paused'); results.manualHandover = true;
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    const startTime = Date.now();
    let lastHumanInput = 0;
    await until(async () => {
        if (Date.now() - lastHumanInput > 15_000) { await canvas.hover({ position: { x: 20, y: 20 } }); lastHumanInput = Date.now(); }
        const s = await state(); snapshots.latest = { controller: s, observation: await observe() };
        if (s.state === 'error' || s.state === 'paused') throw new Error(`Woodcutting stopped unexpectedly: ${JSON.stringify(snapshots.latest)}`);
        return s.state === 'completed';
    }, 'sustained woodcutting and banking', 15 * 60_000);
    const final = await observe(), controller = await state();
    assert.ok(controller.progress.gathered >= 54); assert.ok(controller.progress.banked >= 54); assert.ok(controller.progress.cycles >= 2);
    assert.ok(final.inventory.some(i => i.id === 1351) || final.equipment.some(i => i.id === 1351));
    results.sustained = { durationMs: Date.now() - startTime, controller, final };
    await personal.screenshot({ path: `${resultPath}.png`, fullPage: true });
    // New objective, logout and reconnect: the runner must remain paused and reconcile fresh state.
    await startActivity(100);
    await command({ kind: 'tab', tab: 10 });
    const logout = (await observe()).components.find(c => c.clientCode === 205);
    assert.ok(logout); await command({ kind: 'button', id: logout.id });
    await until(async () => !(await observe()).ready, 'native logout');
    await until(async () => (await state()).state === 'paused', 'logout pauses script');
    await command({ kind: 'login', name: 'pr7bot', password: 'disposable-test' });
    await until(async () => (await observe()).ready, 'reconnect');
    assert.equal((await state()).state, 'paused');
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    await personal.getByRole('button', { name: 'Stop', exact: true }).click(); assert.equal((await state()).state, 'stopped');
    results.reconnect = { explicitResumeRequired: true, stopped: true };
    const exported = await personal.evaluate(() => globalThis.__gameClient.personalController.recorder.export());
    fs.writeFileSync(`${resultPath}.events.json`, exported);
    const events = JSON.parse(exported); assert.ok(events.events.length > 0); assert.ok(events.events.some(e => e.type === 'action-result'));
    assert.doesNotMatch(exported, /disposable-test|loginPass|passwordHash|privateKey/);
    results.recording = { events: events.events.length, dropped: events.dropped, bounded: events.events.length <= 1500 };
    await until(() => observer().coexistTicks >= 100, '100 bots coexist with two ordinary players');
    results.concurrent = observer(); assert.equal(results.concurrent.minBots, 100);
    await personal.context().close(); await human.context().close(); await stop();
    const verification = spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/experiments/personal-bot-world.ts'), '--verify-saves'], { cwd: temp, env: worldEnv, encoding: 'utf8', timeout: 30_000 });
    assert.equal(verification.status, 0, verification.stdout + verification.stderr); results.verifiedSaveCrcs = 102;
    const checkDb = new DatabaseSync(path.join(temp, 'db.sqlite'), { readOnly: true });
    results.database = { quickCheck: checkDb.prepare('PRAGMA quick_check').get(), accounts: checkDb.prepare('SELECT COUNT(*) AS count FROM account').get() };
    checkDb.close(); assert.equal(results.database.quickCheck.quick_check, 'ok'); assert.equal(results.browserErrors.length, 0);
    results.passed = true;
} catch (error) {
    results.passed = false; results.error = error.stack; results.debug = snapshots;
    for (const p of browser?.contexts().flatMap(c => c.pages()) ?? []) await p.screenshot({ path: `${resultPath}.png`, fullPage: true }).catch(() => {});
    throw error;
} finally {
    await browser?.close();
    try { await stop(); } finally {
        if (log !== undefined) fs.closeSync(log);
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2)); fs.rmSync(temp, { recursive: true, force: true });
    }
}
