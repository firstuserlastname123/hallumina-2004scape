/** Optional Docker boundary for the experiment; never used by production startup. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dockerHost = 'unix:///var/run/docker.sock';
async function docker(args, output = false) {
    return await new Promise((resolve, reject) => {
        const child = spawn('docker', ['--host', dockerHost, ...args], { stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, DOCKER_CONTEXT: '', DOCKER_TLS_VERIFY: '' } });
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data; if (output) process.stdout.write(data); });
        child.stderr.on('data', data => { stderr += data; if (output) process.stderr.write(data); });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`docker ${args[0]} failed (${code}): ${stderr.slice(-4000)}`)));
    });
}

function digestTree(root) {
    const hash = createHash('sha256');
    function visit(current, relative) {
        if (!fs.existsSync(current)) { hash.update(`missing:${relative}`); return; }
        const stat = fs.statSync(current);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), path.join(relative, name));
        else if (stat.isFile()) { hash.update(relative); hash.update(fs.readFileSync(current)); }
    }
    visit(root, '.');
    return hash.digest('hex');
}

export function checkContainerIsolation() {
    assert.equal(process.env.PERSONAL_BOT_CONTAINER, '1', 'Use the Docker launcher');
    const root = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find(line => line.split(' ')[4] === '/');
    assert.ok(root?.split(' ')[5].split(',').includes('ro'), 'Container root must be read-only');
    assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo'], 'Container must have only loopback networking');
    assert.ok(process.env.PERSONAL_BOT_ORIGINAL_RUNTIME);
    assert.equal(fs.existsSync(process.env.PERSONAL_BOT_ORIGINAL_RUNTIME), false, 'Original runtime must not be mounted');
    assert.throws(() => fs.writeFileSync('/personal-bot-write-probe', ''), { code: 'EROFS' });
    return { rootReadOnly: true, networkInterfaces: ['lo'], originalRuntimeVisible: false, rootWriteRejected: 'EROFS' };
}

export async function runInContainer(engine, resultPath, suite = 'personal-bot-smoke.mjs') {
    assert.ok(['personal-bot-smoke.mjs', 'personal-controller-smoke.mjs'].includes(suite));
    assert.ok(path.isAbsolute(resultPath));
    const runtime = fs.realpathSync(path.resolve(engine, '..'));
    const output = path.join(fs.realpathSync(path.dirname(resultPath)), path.basename(resultPath));
    assert.ok(path.relative(runtime, output).startsWith(`..${path.sep}`), 'Write results outside the original runtime');
    for (const target of [resultPath, `${resultPath}.world.log`]) {
        assert.ok(!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink(), 'Result files must not be symlinks');
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr7-container-'));
    const stage = path.join(scratch, 'stage');
    const protectedPaths = ['content', 'engine/data', 'engine/db.sqlite', 'engine/db.sqlite-wal', 'engine/db.sqlite-shm'];
    const before = Object.fromEntries(protectedPaths.map(name => [name, digestTree(path.join(runtime, name))]));
    let container;
    try {
        console.log('Copying an assembled runtime into disposable container storage');
        for (const name of ['src', 'tools', 'node_modules', 'package.json', 'tsconfig.json', 'prisma', 'view', 'public']) {
            fs.cpSync(path.join(engine, name), path.join(stage, 'runtime/engine', name), { recursive: true, dereference: true });
        }
        for (const name of ['raw', 'config', 'pack', 'bot']) fs.cpSync(path.join(engine, 'data', name), path.join(stage, 'runtime/engine/data', name), { recursive: true, dereference: true });
        fs.cpSync(path.join(runtime, 'content'), path.join(stage, 'runtime/content'), { recursive: true, dereference: true });
        for (const name of ['src', 'experiments', 'tsconfig.json']) fs.cpSync(path.join(runtime, 'webclient', name), path.join(stage, 'runtime/webclient', name), { recursive: true, dereference: true });
        // Optional browser tooling is copied too; no host directory is bind-mounted.
        const modulePath = process.env.PLAYWRIGHT_MODULE;
        assert.ok(!modulePath || path.isAbsolute(modulePath) || modulePath.startsWith('file:///'), 'PLAYWRIGHT_MODULE must be an absolute module path');
        const playwright = modulePath ? path.dirname(modulePath.startsWith('file:///') ? fileURLToPath(modulePath) : modulePath) : path.join(engine, 'node_modules/playwright-core');
        assert.equal(JSON.parse(fs.readFileSync(path.join(playwright, 'package.json'), 'utf8')).name, 'playwright-core');
        fs.cpSync(playwright, path.join(stage, 'playwright-core'), { recursive: true, dereference: true });
        // docker cp can retain source ownership. Make only the disposable copy
        // readable/executable without requiring DAC override capabilities.
        function readableCopy(directory) {
            fs.chmodSync(directory, 0o755);
            for (const name of fs.readdirSync(directory)) {
                const entry = path.join(directory, name), stat = fs.statSync(entry);
                if (stat.isDirectory()) readableCopy(entry);
                else fs.chmodSync(entry, stat.mode & 0o111 ? 0o755 : 0o644);
            }
        }
        readableCopy(stage);
        const image = process.env.PERSONAL_BOT_IMAGE || 'pr7-personal-bot:node24';
        try { await docker(['image', 'inspect', image]); }
        catch {
            assert.equal(process.env.PERSONAL_BOT_IMAGE, undefined, 'Provide an existing custom image');
            await docker(['build', '-t', image, '-f', path.join(engine, 'tools/experiments/Dockerfile.personal-bot'), path.join(engine, 'tools/experiments')], true);
        }
        container = await docker(['create', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--mount', 'type=volume,destination=/experiment', '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
            '--workdir', '/experiment/runtime/engine', '--entrypoint', 'node',
            '-e', 'PERSONAL_BOT_CONTAINER=1', '-e', `PERSONAL_BOT_ORIGINAL_RUNTIME=${runtime}`,
            '-e', 'PERSONAL_BOT_RESULTS=/experiment/results.json', '-e', 'PLAYWRIGHT_MODULE=/experiment/playwright-core/index.mjs',
            // Exercise the explicit world override even when engine debugging is inherited.
            '-e', `NODE_DEBUG=${process.env.NODE_DEBUG ?? 'true'}`,
            image, `tools/experiments/${suite}`]);
        const configuration = JSON.parse(await docker(['inspect', container]))[0];
        assert.equal(configuration.HostConfig.ReadonlyRootfs, true);
        assert.equal(configuration.HostConfig.NetworkMode, 'none');
        assert.equal(Object.keys(configuration.HostConfig.PortBindings ?? {}).length, 0);
        assert.deepEqual(configuration.HostConfig.CapDrop, ['ALL']);
        assert.ok(configuration.HostConfig.SecurityOpt.includes('no-new-privileges'));
        assert.equal(configuration.Mounts.length, 1);
        assert.equal(configuration.Mounts[0].Type, 'volume');
        assert.equal(configuration.Mounts[0].Destination, '/experiment');
        await docker(['cp', `${stage}/.`, `${container}:/experiment`]);
        let startError;
        try { await docker(['start', '--attach', container], true); }
        catch (error) { startError = error; }
        const exit = JSON.parse(await docker(['inspect', container]))[0].State.ExitCode;
        try {
            await docker(['cp', `${container}:/experiment/results.json`, resultPath]);
            await docker(['cp', `${container}:/experiment/results.json.world.log`, `${resultPath}.world.log`]);
            if (suite === 'personal-controller-smoke.mjs') {
                for (const suffix of ['.png', '.events.json']) {
                    try { await docker(['cp', `${container}:/experiment/results.json${suffix}`, `${resultPath}${suffix}`]); } catch { /* Optional failure artifacts. */ }
                }
            }
        } catch (error) { throw startError || error; }
        const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const after = Object.fromEntries(protectedPaths.map(name => [name, digestTree(path.join(runtime, name))]));
        assert.deepEqual(after, before, 'Original content, configuration, saves and database must stay unchanged');
        results.container = { image, imageId: configuration.Image, networkMode: configuration.HostConfig.NetworkMode, publishedPorts: [], readOnlyRootfs: true,
            mounts: [{ type: 'disposable-volume', destination: '/experiment' }], capDrop: ['ALL'], noNewPrivileges: true,
            originalRuntimeUnchanged: true, originalDigests: after };
        fs.writeFileSync(resultPath, JSON.stringify(results, null, 2));
        assert.equal(exit, 0, results.error || 'Container experiment failed');
        assert.equal(results.passed, true);
    } finally {
        if (container) await docker(['rm', '--force', '--volumes', container]);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
