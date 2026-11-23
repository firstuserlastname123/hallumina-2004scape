// Adapted from rs2b0t's schema/SettingsBag pattern. See bot/NOTICE.
export type Setting =
    | { type: 'number'; label: string; default: number; min: number; max: number }
    | { type: 'boolean'; label: string; default: boolean }
    | { type: 'string'; label: string; default: string; options: readonly string[] };
export type SettingsSchema = Record<string, Setting>;
export type Settings = Record<string, string | number | boolean>;
export function resolveSettings(schema: SettingsSchema, values: unknown): Settings {
    const source = values && typeof values === 'object' ? values as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(schema).map(([key, def]) => {
        const value = source[key] ?? def.default;
        if (def.type === 'number' && (typeof value !== 'number' || !Number.isInteger(value) || value < def.min || value > def.max)) throw new Error(`Invalid ${def.label}`);
        if (def.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${def.label}`);
        if (def.type === 'string' && (typeof value !== 'string' || !def.options.includes(value))) throw new Error(`Invalid ${def.label}`);
        return [key, value as string | number | boolean];
    }));
}
