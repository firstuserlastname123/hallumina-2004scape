import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Run from the assembled runtime: node --import tsx --test tests/build-integrity.test.ts
const engine = fileURLToPath(new URL('../', import.meta.url));

test('Progressive r254 builds with integrity checks and rejects changed content', async t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'progressive-integrity-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const content = path.join(temp, 'content');
    const work = path.join(temp, 'engine');
    fs.cpSync(path.join(engine, '../content'), content, { recursive: true });
    fs.mkdirSync(path.join(work, 'data'), { recursive: true });
    fs.symlinkSync(path.join(engine, 'data/raw'), path.join(work, 'data/raw'), 'dir');
    fs.symlinkSync(path.join(engine, 'tools'), path.join(work, 'tools'), 'dir');
    fs.symlinkSync(path.join(engine, 'node_modules'), path.join(work, 'node_modules'), 'dir');

    function build() {
        // Every case starts without generated packs, so timestamps cannot skip validation.
        fs.rmSync(path.join(work, 'data/pack'), { recursive: true, force: true });
        return spawnSync(process.execPath, ['--import', 'tsx', path.join(engine, 'tools/pack/Build.ts')], {
            cwd: work,
            env: {
                ...process.env,
                ENGINE_REVISION: '254',
                BUILD_SRC_DIR: content,
                BUILD_VERIFY: 'true',
                BUILD_VERIFY_FOLDER: 'true',
                BUILD_VERIFY_PACK: 'true'
            },
            encoding: 'utf8',
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024
        });
    }

    await t.test('fresh bundled content compiles and produces server scripts', () => {
        const result = build();
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.ok(fs.statSync(path.join(work, 'data/pack/server/script.dat')).size > 0);
        assert.ok(fs.statSync(path.join(work, 'data/pack/ondemand.zip')).size > 0);
    });

    const mutations = [
        ['.npc', 'areas/area_wilderness/configs/king_dragon.npc', 'name=Prince black dragon', 'name=Changed pet'],
        ['.obj', 'areas/area_wilderness/configs/kbd_pet.obj', 'name=Prince black dragon', 'name=Changed pet item'],
        ['.if', 'shop/interfaces/shop_template.if', 'width=88', 'width=89']
    ];
    for (const [extension, relative, original, changed] of mutations) {
        await t.test(`${extension} changes still fail checksum validation`, () => {
            const file = path.join(content, 'scripts', relative);
            const source = fs.readFileSync(file, 'utf8');
            assert.ok(source.includes(original));
            fs.writeFileSync(file, source.replace(original, changed));
            try {
                const result = build();
                assert.ifError(result.error);
                assert.equal(result.status, 1, result.stdout + result.stderr);
                assert.ok((result.stdout + result.stderr).includes(`${extension} checksum mismatch!`), result.stdout + result.stderr);
            } finally {
                fs.writeFileSync(file, source);
            }
        });
    }
});
