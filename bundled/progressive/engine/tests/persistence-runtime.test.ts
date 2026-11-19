import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const engine = fileURLToPath(new URL('../', import.meta.url));
function fixture(t: any) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-runtime-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    for (const name of ['src', 'node_modules', 'package.json', 'tsconfig.json']) fs.symlinkSync(path.join(engine, name), path.join(temp, name));
    fs.mkdirSync(path.join(temp, 'data'));
    for (const name of ['pack', 'config', 'raw', 'bot']) fs.symlinkSync(path.join(engine, 'data', name), path.join(temp, 'data', name));
    const db = new DatabaseSync(path.join(temp, 'db.sqlite'));
    const migrations = path.join(engine, 'prisma/singleworld/migrations');
    for (const dir of fs.readdirSync(migrations).sort()) {
        const sql = path.join(migrations, dir, 'migration.sql');
        if (fs.existsSync(sql)) db.exec(fs.readFileSync(sql, 'utf8'));
    }
    db.close();
    return { cwd: temp, env: { ...process.env, DB_BACKEND: 'sqlite', NODE_PRODUCTION: 'true', LOGIN_SERVER: 'false',
        FRIEND_SERVER: 'false', LOGGER_SERVER: 'false', BOT_LOG_LEVEL: 'off', BOT_DEBUG_ENABLED: 'false', LOGIN_PORT: '0',
        BUILD_STARTUP: 'false', BUILD_SRC_DIR: path.resolve(engine, '../content') } };
}
function run(options: any, name: string, phase?: string) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tests/fixtures', name), ...(phase ? [phase] : [])], {
        ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
}

test('central logout rejects invalid, regressing and failed persistence; acknowledges only after DB writes', t => {
    assert.match(run(fixture(t), 'persistence-login.ts'), /persistence login checks passed/);
});

test('human and configured bots retain progression after complete world shutdown and fresh process restart', async t => {
    const options = fixture(t);
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(engine, 'tests/fixtures/persistence-restart.ts'), 'save'], options);
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
        output += data;
        if (output.includes('ready for shutdown signal') && !child.killed) child.kill('SIGTERM');
    });
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    assert.match(output, /Server shutdown complete/);
    assert.match(run(options, 'persistence-restart.ts', 'restore'), /persistence restart checks passed/);
});

test('logout identities fence delayed acknowledgements, local retries and shutdown completion', t => {
    assert.match(run(fixture(t), 'persistence-acknowledgements.ts'), /persistence acknowledgement checks passed/);
});

for (const mode of ['local', 'central']) {
    test(`${mode} login ownership follows World admission and preserves pending logouts`, t => {
        assert.match(run(fixture(t), 'persistence-admission.ts', mode), /persistence admission .* checks passed/);
    });
}

test('configured fresh bots use the native tutorial skip and resume safely across restart', t => {
    const options = fixture(t);
    assert.match(run(options, 'bot-tutorial.ts'), /tutorial creation checks passed/);
    assert.match(run(options, 'bot-tutorial.ts', 'restore'), /tutorial restart checks passed/);
});
