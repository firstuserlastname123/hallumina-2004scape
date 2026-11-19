import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const engine = fileURLToPath(new URL('../', import.meta.url));
for (const mode of ['world', 'decisions', 'geared', 'travel-fit', 'bank']) {
    test('native r254 melee regression — ' + mode, () => {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'tools/bot/investigate-combat.ts', mode], {
            cwd: engine, encoding: 'utf8', timeout: 120_000
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });
}
