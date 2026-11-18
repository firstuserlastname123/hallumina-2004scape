import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Like build-integrity.test.ts, these checks require an assembled r254 runtime.
function runtimeFixture(fixture: string, t: TestContext): void {
    const engine = fileURLToPath(new URL('../', import.meta.url));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-regression-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    for (const entry of ['src', 'data', 'node_modules', 'package.json', 'tsconfig.json']) fs.symlinkSync(path.join(engine, entry), path.join(temp, entry));
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tests/fixtures', fixture)], {
        cwd: temp, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, DB_BACKEND: 'sqlite', NODE_PRODUCTION: 'true', BOT_DEBUG_ENABLED: 'false', BOT_LOG_LEVEL: 'off',
            BUILD_SRC_DIR: path.resolve(engine, '../content') }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /runtime regression checks passed/);
}

test('navigation and task recovery against the real r254 engine and map', t => runtimeFixture('bot-runtime.ts', t));
test('destination jitter, dynamic routes and bounded subtask recovery', t => runtimeFixture('bot-navigation-review.ts', t));
test('doors, locked barriers, stairs, resources and social destinations on the r254 map', t => runtimeFixture('bot-environment.ts', t));
