import type { Action, ActionResult, GamePort, Observation } from './Types.js';
import type { Settings } from '../runtime/Settings.js';
export interface Progress { gathered: number; banked: number; cycles: number; elapsed: number }
export interface ScriptContext {
    readonly settings: Settings; readonly progress: Progress; readonly game: Pick<GamePort, 'approach'>;
    readonly pending: boolean; readonly lastResult: ActionResult | null;
    act(action: Action, verify: (after: Observation) => boolean, timeoutMs?: number): void;
    status(message: string): void; log(message: string, level?: 'info' | 'warn' | 'error'): void;
    pause(reason: string): void; complete(reason: string): void;
}
/** Each loop is synchronous and bounded. No detached timers or unguarded packet access. */
export interface BotScript {
    onStart(ctx: ScriptContext, observation: Observation): void;
    onTick(ctx: ScriptContext, observation: Observation): void;
    onPause?(reason: string): void;
    onResume?(observation: Observation): void;
    onStop?(reason: string): void;
}
