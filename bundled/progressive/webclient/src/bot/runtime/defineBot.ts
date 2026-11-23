// Adapted from rs2b0t's defineBot manifest helper. See bot/NOTICE.
import type { ScriptMeta } from './ScriptRegistry.js';
export function defineBot(meta: ScriptMeta): ScriptMeta {
    if (!/^[a-z][a-z0-9-]*$/.test(meta.id) || !meta.name || typeof meta.create !== 'function') throw new Error('Invalid script manifest');
    return Object.freeze(meta);
}
