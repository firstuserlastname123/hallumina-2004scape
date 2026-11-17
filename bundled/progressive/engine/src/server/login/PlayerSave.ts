import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Packet from '#/io/Packet.js';

export const SAV_MAGIC = 0x2004;
export const SAV_VERSION = 7;

// Shared with PlayerLoading without importing World (which starts workers).
export function verifyPlayerSave(sav: Packet): boolean {
    if (sav.data.length < 8 || sav.g2() !== SAV_MAGIC || sav.g2() > SAV_VERSION) return false;
    sav.pos = sav.data.length - 4;
    return sav.g4s() === Packet.getcrc(sav.data, 0, sav.data.length - 4);
}

const pending = new Map<string, Promise<unknown>>();

// Serialize validation, replacement and logout bookkeeping for the same save.
// An older autosave must never overtake the final logout snapshot.
export async function withPlayerSaveLock<T>(filename: string, action: () => Promise<T>): Promise<T> {
    const previous = pending.get(filename) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    pending.set(filename, current);
    try {
        return await current;
    } finally {
        if (pending.get(filename) === current) pending.delete(filename);
    }
}

export async function writePlayerSave(filename: string, raw: Uint8Array): Promise<void> {
    if (!verifyPlayerSave(new Packet(raw))) throw new Error('Invalid save file');
    const directory = path.dirname(filename);
    await fs.mkdir(directory, { recursive: true });
    // Same directory guarantees rename stays on the same filesystem. Never
    // truncate the previous save; an interrupted write leaves it readable.
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(raw);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporary, filename);
        // POSIX requires syncing the directory to make the rename durable.
        // Windows does not support opening directories for fsync via Node.
        if (process.platform !== 'win32') {
            const dir = await fs.open(directory, 'r');
            try { await dir.sync(); } finally { await dir.close(); }
        }
    } finally {
        if (handle) await handle.close();
        await fs.rm(temporary, { force: true });
    }
}

export type SaveOperation = {
    saveId: string;
    saveSequence: number;
    sessionId: string;
};

export type SaveOperationState = SaveOperation & { completed: boolean };

// Called inside the character lock. Sequences order snapshots within one world
// incarnation; the operation ID remains unchanged across all retries.
export function checkSaveOperation(operation: SaveOperation, previous?: SaveOperationState): boolean {
    if (typeof operation.saveId !== 'string' || !operation.saveId ||
        typeof operation.sessionId !== 'string' || !operation.sessionId ||
        !Number.isSafeInteger(operation.saveSequence) || operation.saveSequence < 1) {
        throw new Error('Missing save operation identity');
    }
    if (!previous || operation.saveSequence > previous.saveSequence) return false;
    if (operation.saveSequence === previous.saveSequence && operation.saveId === previous.saveId && operation.sessionId === previous.sessionId) {
        return previous.completed;
    }
    throw new Error('Stale save operation');
}
