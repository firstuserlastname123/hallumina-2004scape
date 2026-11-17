import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import Packet from '#/io/Packet.js';
import { writePlayerSave, withPlayerSaveLock } from '#/server/login/PlayerSave.js';

function snapshot(value: number) {
    const raw = Buffer.alloc(12);
    raw.writeUInt16BE(0x2004); raw.writeUInt16BE(7, 2); raw.writeUInt32BE(value, 4);
    raw.writeInt32BE(Packet.getcrc(raw, 0, 8), 8);
    return raw;
}

test('save replacement preserves bytes, validates CRC and retains old save on write/sync/rename failure', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-save-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'main', 'player.sav');
    const before = snapshot(1), after = snapshot(2);
    await writePlayerSave(file, before);
    const corrupt = Buffer.from(after); corrupt[4] ^= 1;
    await assert.rejects(writePlayerSave(file, corrupt), /Invalid save/);
    assert.deepEqual(await fs.readFile(file), before);
    for (const stage of ['writeFile', 'sync', 'rename']) {
        await t.test(stage, async () => {
            const open = fs.open.bind(fs);
            const failure = new Error(`injected ${stage} failure`);
            if (stage === 'rename') mock.method(fs, 'rename', async () => { throw failure; });
            else mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
                const handle = await open(...args);
                if (args[1] === 'wx') mock.method(handle, stage, async () => {
                    if (stage === 'writeFile') await handle.write(after.subarray(0, 5));
                    throw failure;
                });
                return handle;
            });
            try { await assert.rejects(writePlayerSave(file, after), failure); }
            finally { mock.restoreAll(); }
            assert.deepEqual(await fs.readFile(file), before);
            assert.deepEqual(await fs.readdir(path.dirname(file)), ['player.sav']);
        });
    }
    await writePlayerSave(file, after);
    assert.deepEqual(await fs.readFile(file), after);
});

test('same-character autosave/logout operations stay ordered and recover after a failure', async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withPlayerSaveLock('player', async () => { await gate; order.push(1); throw new Error('disk full'); });
    const rejection = assert.rejects(first, /disk full/);
    const second = withPlayerSaveLock('player', async () => { order.push(2); });
    await withPlayerSaveLock('other player', async () => { order.push(0); });
    assert.deepEqual(order, [0]);
    release();
    await Promise.all([rejection, second]);
    assert.deepEqual(order, [0, 1, 2]);
});

test('killing a writer mid-write leaves the previous save usable and the next save can replace it', async t => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interrupted-save-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'player.sav');
    await writePlayerSave(file, snapshot(1));
    const module = new URL('../src/server/login/PlayerSave.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import fs from 'node:fs/promises';
        const { writePlayerSave } = await import(process.argv[1]);
        const open = fs.open.bind(fs);
        fs.open = async (...args) => {
            const handle = await open(...args);
            if (args[1] === 'wx') handle.writeFile = async raw => {
                await handle.write(raw.subarray(0, 5));
                console.log('partial write');
                await new Promise(() => { setInterval(() => {}, 1000); });
            };
            return handle;
        };
        await writePlayerSave(process.argv[2], Buffer.from(process.argv[3], 'base64'));
    `, module, file, snapshot(2).toString('base64')]);
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
    child.stdout.on('data', data => {
        output += data;
        if (output.includes('partial write')) child.kill('SIGKILL');
    });
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    await once(child, 'exit');
    assert.match(output, /partial write/, errors);
    assert.deepEqual(await fs.readFile(file), snapshot(1));
    await writePlayerSave(file, snapshot(3));
    assert.deepEqual(await fs.readFile(file), snapshot(3));
});
