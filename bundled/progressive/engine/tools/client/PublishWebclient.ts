import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Shared by the launcher and GE staging so both deploy the optional client. */
export function publishWebclient(engine: string, personalOnly = false): string[] {
    const source = path.resolve(engine, '../webclient/out');
    const destination = path.join(engine, 'public/client');
    const names = personalOnly
        ? ['personal-client.js', 'personal-client.js.map', 'personal-client.NOTICE.txt', 'tinymidipcm.wasm']
        : ['client.js', 'client.js.map', 'personal-client.js', 'personal-client.js.map', 'personal-client.NOTICE.txt', 'mapview.js', 'mapview.js.map', 'tinymidipcm.wasm'];
    // Validate the complete build before replacing any published asset.
    for (const name of names) {
        if (!fs.statSync(path.join(source, name)).isFile() || !fs.statSync(path.join(source, name)).size) {
            throw new Error(`Missing or empty webclient build output: ${name}`);
        }
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const name of names) {
        const target = path.join(destination, name), temporary = `${target}.${process.pid}.tmp`;
        try { fs.copyFileSync(path.join(source, name), temporary); fs.renameSync(temporary, target); }
        finally { fs.rmSync(temporary, { force: true }); }
    }
    return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    console.log(`Published: ${publishWebclient(engine, process.argv.includes('--personal')).join(', ')}`);
}
