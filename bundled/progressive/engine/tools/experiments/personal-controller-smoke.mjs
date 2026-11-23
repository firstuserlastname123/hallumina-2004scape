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
import { createHash } from 'node:crypto';
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
let browser, child, log, worldEnv;
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
function verifyPersistence() {
    if (!worldEnv) return;
    const verification = spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/experiments/personal-bot-world.ts'), '--verify-saves'], { cwd: temp, env: worldEnv, encoding: 'utf8', timeout: 30_000 });
    assert.equal(verification.status, 0, verification.stdout + verification.stderr); results.verifiedSaveCrcs = 102;
    const checkDb = new DatabaseSync(path.join(temp, 'db.sqlite'), { readOnly: true });
    results.database = { quickCheck: checkDb.prepare('PRAGMA quick_check').get(), accounts: checkDb.prepare('SELECT COUNT(*) AS count FROM account').get() };
    checkDb.close(); assert.equal(results.database.quickCheck.quick_check, 'ok');
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
    if (fs.existsSync(path.join(engine, '.native-test-character.sav'))) {
        results.characterFixture = JSON.parse(fs.readFileSync(path.join(engine, '.native-test-character.json'), 'utf8'));
        fs.mkdirSync(path.join(temp, 'data/players/external-framework-test'), { recursive: true });
        fs.copyFileSync(path.join(engine, '.native-test-character.sav'), path.join(temp, 'data/players/external-framework-test/pr7bot.sav'));
    }
    const deployed = results.characterFixture?.tutorial === 1000;
    // Completed fixtures run against the actual published production assets.
    // Fresh tutorial preparation alone uses the separate native test driver.
    // public.pem can be stale in assembled installations. Derive only the public
    // components from the key the native login listener actually uses.
    const key = forge.pki.privateKeyFromPem(fs.readFileSync(path.join(engine, 'data/config/private.pem'), 'utf8'));
    const webclient = path.resolve(engine, '../webclient');
    const define = { 'process.env.SECURE_ORIGIN': JSON.stringify('127.0.0.1'), 'process.env.LOGIN_RSAN': JSON.stringify(key.n.toString(10)),
        'process.env.LOGIN_RSAE': JSON.stringify(key.e.toString(10)), 'process.env.BUILD_TIME': JSON.stringify('r254-personal-experiment') };
    if (!deployed) for (const [entry, output] of [['experiments/personal-controller-driver.ts', 'experiment.js'], ['src/client/ClientEntry.ts', 'native.js']]) {
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
    worldEnv = { ...process.env,
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
    if (deployed) {
        results.deployment = { substitutedAssets: false, assets: [] };
        for (const name of ['client.js', 'client.js.map', 'personal-client.js', 'personal-client.js.map', 'personal-client.NOTICE.txt']) {
            const response = await fetch(`http://127.0.0.1:${port}/client/${name}`);
            assert.equal(response.status, 200);
            const actual = Buffer.from(await response.arrayBuffer()), expected = fs.readFileSync(path.join(engine, 'public/client', name));
            assert.deepEqual(actual, expected);
            if (name.endsWith('.js.map')) { const map = JSON.parse(actual); assert.equal(map.version, 3); assert.ok(map.sourcesContent.length > 0); }
            if (name.endsWith('.js')) assert.ok(actual.toString().includes('sourceMappingURL=' + name + '.map'));
            results.deployment.assets.push({ name, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') });
        }
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
        args: ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    results.runtime.chromium = browser.version();
    async function page(experimental) {
        const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
        const p = await context.newPage();
        p.on('pageerror', error => results.browserErrors.push(error.message));
        p.on('console', msg => { if (msg.type() === 'error') console.error('browser:', msg.text()); });
        if (!deployed) await p.route(/\/client\/(?:personal-client|client)\.js/, route => route.fulfill({ path: path.join(temp, experimental ? 'experiment.js' : 'native.js'), contentType: 'application/javascript' }));
        await p.goto(`http://127.0.0.1:${port}/rs2.cgi?lowmem=1${experimental ? '&personalBot=1' : ''}`);
        return p;
    }
    const personal = await page(true);
    const observe = () => personal.evaluate(deployed => deployed ? globalThis.__gameClient.personalController.game.observe() : globalThis.__pr8Test.snapshot(), deployed);
    async function canvasPoint(p, x, y) {
        return p.locator('canvas#canvas').evaluate((canvas, {x,y}) => {
            const rect = canvas.getBoundingClientRect(); return { x: x * rect.width / canvas.width, y: y * rect.height / canvas.height };
        }, {x,y});
    }
    async function login(p, name, password) {
        const c = p.locator('canvas#canvas');
        if (await p.evaluate(() => globalThis.__gameClient.loginscreen === 2)) {
            await c.click({ position: await canvasPoint(p, 462, 321) }); // native Cancel clears the prior attempt
            await p.waitForFunction(() => globalThis.__gameClient.loginscreen === 0);
        }
        await c.click({ position: await canvasPoint(p, 462, 291) });
        await p.waitForFunction(() => globalThis.__gameClient.loginscreen === 2);
        await p.keyboard.type(name, { delay: 30 }); await p.keyboard.press('Tab'); await p.keyboard.type(password, { delay: 30 });
        await p.waitForFunction(({name,length}) => globalThis.__gameClient.loginUser === name && globalThis.__gameClient.loginPass.length === length, { name, length: password.length });
        await c.click({ position: await canvasPoint(p, 302, 321) });
        await until(async () => await p.evaluate(() => globalThis.__gameClient.ingame || /Invalid|disabled|already logged/i.test(globalThis.__gameClient.loginMes1 + globalThis.__gameClient.loginMes2)), 'native login response');
        if (await p.evaluate(() => globalThis.__gameClient.ingame)) {
            await p.waitForFunction(() => globalThis.__gameClient.sceneState === 2);
            const welcome = await p.evaluate(() => globalThis.__gameClient.personalController?.game.observe().interfaces.some(i => /Welcome to RuneScape|You last logged/i.test(i.text)));
            if (welcome) {
                await c.hover({ position: await canvasPoint(p, 483, 95) }); await delay(200);
                await c.click({ position: await canvasPoint(p, 483, 95) });
                await p.waitForFunction(() => globalThis.__gameClient.mainModalId === -1);
            }
        }
    }
    const command = async a => {
        if (!deployed) return personal.evaluate(a => globalThis.__pr8Test.command(a), a);
        if (a.kind === 'login') return login(personal, a.name, a.password);
        return personal.evaluate(a => {
            const c = globalThis.__gameClient, game = c.personalController.game;
            if (a.kind === 'tab') { c.sideTab = a.tab; c.redrawSidebar = true; c.redrawSideicons = true; return; }
            const s = game.observe(), action = a.kind === 'walk' ? { kind: 'walk', tile: { x: a.x, z: a.z, level: 0 } } : a;
            const result = game.dispatch({ action, sequence: s.sequence, account: s.account, deadline: Date.now() + 10000 });
            if (!result.accepted) throw new Error(result.reason);
            return result;
        }, a);
    };
    await personal.waitForFunction(() => globalThis.__gameClient?.viewportScanline, null, { timeout: 180_000 });
    if (deployed) assert.equal(await personal.evaluate(() => typeof globalThis.__pr8Test), 'undefined');
    assert.equal(await personal.locator('.hb-panel').count(), 1);
    assert.equal(await personal.locator('input[type=checkbox]').count(), 1);
    await command({ kind: 'login', name: 'pr7bot', password: 'wrong-password' });
    assert.equal((await observe()).account, null); results.wrongPasswordRejected = true;
    await command({ kind: 'login', name: 'pr7bot', password: 'disposable-test' });
    await until(async () => (await observe())?.ready, 'ordinary native login');
    await personal.getByLabel('Record gameplay events').check();
    const locIds = Object.fromEntries(fs.readFileSync(path.resolve(engine, '../content/pack/loc.pack'), 'utf8').trim().split(/\r?\n/).map(line => { const [id, name] = line.split('='); return [name, Number(id)]; }));
    if (!deployed) await finishTutorial(personal, results, locIds, () => observer().players.find(p => p.name === 'pr7bot')?.tutorial);
    else assert.equal(observer().players.find(p => p.name === 'pr7bot')?.tutorial, 1000);
    await until(async () => { const s = await observe(); return s.ready && s.position?.z >= 3200; }, 'native mainland scene after tutorial');
    console.log('Completed all native Tutorial Island prerequisites');
    results.steps.push({ name: 'legitimate-tutorial-complete', state: await observe() });
    // The same ordinary character travels from its native earned save position.
    const initialPosition = (await observe()).position;
    let travel = Math.max(Math.abs(initialPosition.x - 3083), Math.abs(initialPosition.z - 3265)) <= 30 ? [[3083, 3264]] :
        [[3220, 3229], [3200, 3230], [3178, 3237], [3156, 3238], [3136, 3256], [3136, 3278], [3114, 3278], [3094, 3278], [3083, 3264]];
    // Resume preparation at the nearest already-earned waypoint when a prior
    // isolated run exported its native travel save.
    const nearest = travel.map(([x,z], index) => ({ index, distance: Math.max(Math.abs(x - initialPosition.x), Math.abs(z - initialPosition.z)) })).sort((a,b) => a.distance - b.distance)[0];
    if (nearest?.distance <= 3) travel = travel.slice(nearest.index + 1);
    for (const [x, z] of travel) {
        await until(async () => { const s = await observe(); return s.ready; }, 'travel scene ready');
        const destination = await personal.evaluate(({x,z}) => {
            const s = globalThis.__gameClient.personalController.game.observe(), game = globalThis.__gameClient.personalController.game;
            for (let radius = 0; radius <= 12; radius++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
                const tile = { x: x + dx, z: z + dz, level: 0 };
                if (s.objects.some(o => tile.x >= o.x && tile.x < o.x + (o.width ?? 1) && tile.z >= o.z && tile.z < o.z + (o.length ?? 1))) continue;
                if (game.approach(tile)) return tile;
            }
            return null;
        }, {x,z});
        assert.ok(destination, `Reachable floor near native travel waypoint ${x},${z}`);
        console.log('Native travel', JSON.stringify(destination));
        await command({ kind: 'walk', x: destination.x, z: destination.z });
        await until(async () => { const s = await observe(); return s.position?.x === destination.x && s.position.z === destination.z; }, `native travel ${x},${z}`, 60_000);
    }
    await personal.locator('canvas#canvas').click({ position: await canvasPoint(personal, 644, 83) });
    results.manualRecordingWhileIdle = await until(() => personal.evaluate(() => JSON.parse(globalThis.__gameClient.personalController.recorder.export()).events.some(e => e.type === 'manual-command')), 'native manual movement recording', 5000);
    assert.equal(results.manualRecordingWhileIdle, true);
    const human = await page(false);
    assert.equal(await human.locator('.hb-panel').count(), 0);
    assert.equal(await human.evaluate(() => typeof globalThis.__pr8Test), 'undefined');
    await human.waitForFunction(() => globalThis.__gameClient?.viewportScanline, null, { timeout: 180_000 });
    const canvas = human.locator('canvas#canvas');
    await canvas.click({ position: await canvasPoint(human, 462, 291) });
    await human.waitForFunction(() => globalThis.__gameClient.loginscreen === 2);
    await human.keyboard.type('pr7human', { delay: 30 }); await human.keyboard.press('Tab'); await human.keyboard.type('disposable-test', { delay: 30 });
    await human.waitForFunction(() => globalThis.__gameClient.loginUser === 'pr7human' && globalThis.__gameClient.loginPass.length === 15);
    await canvas.click({ position: await canvasPoint(human, 302, 321) });
    await until(() => observer().players.some(p => p.name === 'pr7human'), 'standard client login');
    await human.waitForFunction(() => globalThis.__gameClient.mainModalId === 3559);
    await canvas.hover({ position: await canvasPoint(human, 260, 285) }); await delay(150); await canvas.click({ position: await canvasPoint(human, 260, 285) });
    await until(() => observer().players.find(p => p.name === 'pr7human')?.tutorial === 1, 'standard character design');
    const humanBefore = observer().players.find(p => p.name === 'pr7human').position;
    await canvas.click({ position: await canvasPoint(human, 653, 80) });
    await until(() => { const s = observer().players.find(p => p.name === 'pr7human'); return s && JSON.stringify(s.position) !== JSON.stringify(humanBefore); }, 'standard manual movement');
    results.humanMovement = { before: humanBefore, after: observer().players.find(p => p.name === 'pr7human').position };
    results.automationDisabled = { panelAbsent: true, nativeLogin: true, nativeMovement: true };
    const state = () => personal.evaluate(() => {
        const r = globalThis.__gameClient.personalController;
        return { state: r.state, status: r.status, progress: r.progress, retries: r.retries, logs: r.logs, last: r.lastResult };
    });
    async function startActivity(target) {
        await personal.getByRole('button', { name: 'Start', exact: true }).click();
        await personal.getByLabel('Logs to gather (0 = duration)', { exact: true }).fill(String(target));
        await personal.getByRole('button', { name: 'Start script', exact: true }).click();
        await until(async () => (await state()).state === 'running', 'script started');
    }
    await startActivity(24);
    await until(async () => {
        const controller = await state(); snapshots.latest = { controller, observation: await observe() };
        if (['paused', 'error'].includes(controller.state)) throw new Error(`Gathering could not start: ${JSON.stringify(snapshots.latest)}`);
        return controller.progress.gathered >= 1;
    }, 'first mainland log and XP', 120_000);
    await personal.getByRole('button', { name: 'Pause', exact: true }).click(); assert.equal((await state()).state, 'paused');
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    await personal.locator('canvas#canvas').focus(); await personal.keyboard.press('ArrowLeft');
    assert.equal((await state()).state, 'paused'); results.manualHandover = true;
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    const startTime = Date.now();
    let lastHumanInput = 0, bankBaseline = null;
    results.deposits = [];
    const count = items => (items ?? []).filter(i => i.id === 1511).reduce((n,i) => n + i.count, 0);
    await until(async () => {
        if (Date.now() - lastHumanInput > 15_000) { await canvas.hover({ position: await canvasPoint(human, 20, 20) }); lastHumanInput = Date.now(); }
        const s = await state(); snapshots.latest = { controller: s, observation: await observe() };
        const observation = snapshots.latest.observation;
        if (observation.bank !== null) {
            const current = { at: observation.at, inventory: count(observation.inventory), bank: count(observation.bank), axe: observation.inventory.some(i => i.id === 1351) || observation.equipment.some(i => i.id === 1351), position: observation.position };
            if (bankBaseline && current.inventory < bankBaseline.inventory && current.bank > bankBaseline.bank) {
                assert.equal(bankBaseline.inventory - current.inventory, current.bank - bankBaseline.bank);
                assert.equal(current.axe, true); results.deposits.push({ before: bankBaseline, after: current });
                console.log('Native deposit verified', JSON.stringify(results.deposits.at(-1)));
            }
            bankBaseline = current;
        } else bankBaseline = null;
        if (s.state === 'error' || s.state === 'paused') throw new Error(`Woodcutting stopped unexpectedly: ${JSON.stringify(snapshots.latest)}`);
        return s.state === 'completed';
    }, 'sustained woodcutting and banking', 15 * 60_000);
    const final = await observe(), controller = await state();
    assert.ok(results.deposits.length >= 2, 'Two inventory reductions matched by bank increases');
    assert.ok(controller.progress.gathered >= 24); assert.ok(controller.progress.banked >= 24); assert.ok(controller.progress.cycles >= 2);
    assert.ok(final.inventory.some(i => i.id === 1351) || final.equipment.some(i => i.id === 1351));
    const protectedItems = s => [...s.inventory, ...s.equipment].filter(i => i.id !== 1511).map(i => [i.id, i.count]).sort((a,b) => a[0] - b[0]);
    assert.deepEqual(protectedItems(final), protectedItems(results.steps[0].state));
    results.protectedItemsPreserved = true;
    results.sustained = { durationMs: Date.now() - startTime, controller, final };
    await personal.screenshot({ path: `${resultPath}.completed.png`, fullPage: true });
    const nativeBank = await until(() => {
        const items = observer().players.find(p => p.name === 'pr7bot')?.bank ?? [];
        const server = items.filter(i => i.id === 1511).reduce((n,i) => n + i.count, 0), client = results.deposits.at(-1).after.bank;
        return server === client && { server, client };
    }, 'native server bank confirms final client bank', 5000);
    results.nativeBankConfirmed = nativeBank;
    const diagnosticsDownload = personal.waitForEvent('download');
    await personal.getByRole('button', { name: 'Export diagnostics', exact: true }).click();
    await (await diagnosticsDownload).saveAs(`${resultPath}.diagnostics.json`);
    const diagnostics = JSON.parse(fs.readFileSync(`${resultPath}.diagnostics.json`, 'utf8'));
    assert.equal(diagnostics.state, 'completed'); assert.equal(diagnostics.progress.gathered, 24);
    results.diagnostics = { downloaded: true, terminalResults: diagnostics.recentResults.length, logs: diagnostics.logs.length };
    // New objective, logout and reconnect: the runner must remain paused and reconcile fresh state.
    await startActivity(100);
    await command({ kind: 'tab', tab: 10 });
    if (deployed) {
        const logout = (await observe()).interfaces.filter(c => c.buttonType === 1);
        assert.equal(logout.length, 1); await command({ kind: 'dialogue', component: logout[0].id });
    } else {
        const logout = (await observe()).components.find(c => c.clientCode === 205);
        assert.ok(logout); await command({ kind: 'button', id: logout.id });
    }
    await until(async () => !(await observe()).ready, 'native logout');
    await until(async () => (await state()).state === 'paused', 'logout pauses script');
    await command({ kind: 'login', name: 'pr7bot', password: 'disposable-test' });
    await until(async () => (await observe()).ready, 'reconnect');
    assert.equal((await state()).state, 'paused');
    await personal.getByRole('button', { name: 'Resume', exact: true }).click();
    await personal.getByRole('button', { name: 'Stop', exact: true }).click(); assert.equal((await state()).state, 'stopped');
    results.reconnect = { explicitResumeRequired: true, stopped: true };
    const downloadPromise = personal.waitForEvent('download');
    await personal.getByRole('button', { name: 'Export events', exact: true }).click();
    const download = await downloadPromise; await download.saveAs(`${resultPath}.events.json`);
    const exported = fs.readFileSync(`${resultPath}.events.json`, 'utf8');
    fs.writeFileSync(`${resultPath}.events.json`, exported);
    const events = JSON.parse(exported); assert.ok(events.events.length > 0); assert.ok(events.events.some(e => e.type === 'action-result'));
    assert.doesNotMatch(exported, /disposable-test|loginPass|passwordHash|privateKey/);
    results.recording = { events: events.events.length, dropped: events.dropped, bounded: events.events.length <= 1500 };
    await startActivity(100);
    // A safety guard may already have paused between Start and this checkpoint.
    // The graphical Pause control is tested earlier during the gathering loop.
    await personal.evaluate(() => globalThis.__gameClient.personalController.pause('Checkpoint before page reload'));
    assert.equal((await state()).state, 'paused');
    const saved = await state();
    await personal.reload();
    await personal.waitForFunction(() => globalThis.__gameClient?.viewportScanline, null, { timeout: 180_000 });
    await until(() => !observer().players.some(p => p.name === 'pr7bot'), 'reload disconnect saved account');
    await command({ kind: 'login', name: 'pr7bot', password: 'disposable-test' });
    await until(async () => (await observe()).ready, 'native login after reload');
    assert.equal((await state()).state, 'idle');
    await personal.getByRole('button', { name: 'Restore saved objective…', exact: true }).click();
    assert.equal((await state()).state, 'idle', 'Parameter review must not resume automatically');
    await personal.getByRole('button', { name: 'Start script', exact: true }).click();
    await until(async () => (await state()).state === 'running', 'explicit objective restore');
    assert.equal((await state()).progress.banked, saved.progress.banked);
    await personal.getByRole('button', { name: 'Stop', exact: true }).click();
    results.objectiveRecovery = { explicitReviewAndStart: true, bankedUnchanged: true, stopped: true };
    await until(() => observer().coexistTicks >= 100, '100 bots coexist with two ordinary players');
    results.concurrent = observer(); assert.equal(results.concurrent.minBots, 100);
    await personal.context().close(); await human.context().close(); await stop();
    verifyPersistence(); assert.equal(results.browserErrors.length, 0);
    results.productionAcceptance = deployed;
    results.passed = true;
} catch (error) {
    results.passed = false; results.error = error.stack; results.debug = snapshots;
    for (const p of browser?.contexts().flatMap(c => c.pages()) ?? []) {
        const personal = p.url().includes('personalBot=1');
        await p.screenshot({ path: `${resultPath}${personal ? '.png' : '.standard.png'}`, fullPage: true }).catch(() => {});
        if (personal) results.failureController = await p.evaluate(() => {
            const r = globalThis.__gameClient?.personalController; return r && { state: r.state, status: r.status, progress: r.progress, logs: r.logs };
        }).catch(() => null);
    }
    throw error;
} finally {
    const observations = path.join(temp, 'observations.json');
    if (!results.concurrent && fs.existsSync(observations)) results.concurrent = JSON.parse(fs.readFileSync(observations, 'utf8'));
    await browser?.close();
    try { await stop(); } finally {
        if (!results.database) {
            try { verifyPersistence(); } catch (error) { results.persistenceError = error.stack; results.passed = false; }
        }
        const earnedSave = path.join(temp, 'data/players/external-framework-test/pr7bot.sav');
        if (fs.existsSync(earnedSave)) {
            const tutorialStages = [...(results.characterFixture?.tutorialStages ?? []), ...(results.tutorial?.map(s => s.stage) ?? [])]
                .filter((stage, index, stages) => index === 0 || stage !== stages[index - 1]);
            fs.copyFileSync(earnedSave, `${resultPath}.character.sav`);
            fs.writeFileSync(`${resultPath}.character.json`, JSON.stringify({ schema: 'hallumina-native-test-character-v1', account: 'pr7bot',
                tutorial: tutorialStages.includes(1000) ? 1000 : tutorialStages.at(-1), tutorialStages,
                sha256: createHash('sha256').update(fs.readFileSync(earnedSave)).digest('hex') }));
        }
        if (log !== undefined) fs.closeSync(log);
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2)); fs.rmSync(temp, { recursive: true, force: true });
    }
}
