import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishWebclient } from '../tools/client/PublishWebclient.js';

test('an incomplete optional build cannot replace the working deployed clients', t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-publication-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const engine = path.join(temp, 'engine'), source = path.join(temp, 'webclient/out'), target = path.join(engine, 'public/client');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target, { recursive: true });
    for (const name of ['client.js', 'client.js.map', 'personal-client.js', 'personal-client.js.map']) fs.writeFileSync(path.join(source, name), 'new build');
    for (const name of ['client.js', 'personal-client.js']) fs.writeFileSync(path.join(target, name), 'working build');
    assert.throws(() => publishWebclient(engine)); // The required MIT notice is absent.
    for (const name of ['client.js', 'personal-client.js']) assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), 'working build');
});

test('an optional-only publication preserves the installed standard client', t => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-publication-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const engine = path.join(temp, 'engine'), source = path.join(temp, 'webclient/out'), target = path.join(engine, 'public/client');
    fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'client.js'), 'working standard client');
    for (const name of ['personal-client.js', 'personal-client.js.map', 'personal-client.NOTICE.txt', 'tinymidipcm.wasm']) fs.writeFileSync(path.join(source, name), name);
    publishWebclient(engine, true);
    assert.equal(fs.readFileSync(path.join(target, 'client.js'), 'utf8'), 'working standard client');
    assert.equal(fs.readFileSync(path.join(target, 'personal-client.NOTICE.txt'), 'utf8'), 'personal-client.NOTICE.txt');
});
