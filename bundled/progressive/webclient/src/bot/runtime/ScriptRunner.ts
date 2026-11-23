import type { Action, ActionResult, GamePort, Observation } from '../api/Types.js';
import type { BotScript, Progress, ScriptContext } from '../api/Script.js';
import type { ScriptMeta } from './ScriptRegistry.js';
import { resolveSettings, type Settings } from './Settings.js';
import { ObjectiveStore, type Objective } from './ObjectiveStore.js';
import { Recorder } from './Recorder.js';

export type RunnerState = 'idle' | 'running' | 'paused' | 'completed' | 'stopped' | 'error';
interface Pending { result: ActionResult; before: Observation; verify(after: Observation): boolean; deadline: number; noticed: boolean }
export class ScriptRunner {
    state: RunnerState = 'idle';
    status = 'Choose a script';
    meta: ScriptMeta | null = null;
    settings: Settings = {};
    progress: Progress = { gathered: 0, banked: 0, cycles: 0, elapsed: 0 };
    observation: Observation | null = null;
    lastResult: ActionResult | null = null;
    lastSuccess: ActionResult | null = null;
    readonly recentResults: ActionResult[] = [];
    logs: { at: number; level: 'info' | 'warn' | 'error'; message: string }[] = [];
    verbosity: 'info' | 'warn' | 'error' = 'info';
    retries = 0;
    private account: string | null = null;
    private script: BotScript | null = null;
    private pendingAction: Pending | null = null;
    private actionId = 0;
    private issuedAction = false;
    private previousPump = 0;
    private lastSave = 0;
    private context: ScriptContext | null = null;
    constructor(readonly game: GamePort, readonly recorder: Recorder, readonly store: ObjectiveStore) {}
    get pending(): boolean { return this.pendingAction !== null; }
    log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
        if (['info', 'warn', 'error'].indexOf(level) < ['info', 'warn', 'error'].indexOf(this.verbosity)) return;
        this.logs.push({ at: Date.now(), level, message: message.slice(0, 500) });
        if (this.logs.length > 200) this.logs.shift();
    }
    start(meta: ScriptMeta, values: Settings, restored?: Objective): void {
        if (this.state === 'running' || this.state === 'paused') throw new Error('Stop the active script first');
        const s = this.game.observe(); this.observation = s;
        if (!s.ready || !s.account) throw new Error('Log in through the game and wait for the scene');
        this.account = s.account; this.meta = meta; this.settings = resolveSettings(meta.settingsSchema, values);
        this.store.savePreferences(s.account, meta.id, this.settings);
        this.progress = restored ? { ...restored.progress } : { gathered: 0, banked: 0, cycles: 0, elapsed: 0 };
        this.script = meta.create(); this.lastResult = null; this.lastSuccess = null; this.pendingAction = null; this.retries = 0;
        this.recentResults.length = 0;
        this.issuedAction = false;
        this.context = {
            settings: this.settings, progress: this.progress, game: this.game,
            get pending() { return runner.pending; }, get lastResult() { return runner.lastResult; },
            act: (a, verify, timeout) => this.act(a, verify, timeout), status: text => { this.status = text; },
            log: (text, level) => this.log(text, level), pause: reason => this.pause(reason), complete: reason => this.finish('completed', reason)
        };
        const runner = this;
        this.state = 'running'; this.previousPump = Date.now();
        try { this.script.onStart(this.context, s); this.log(`${meta.name} started`); this.save(); }
        catch (error) { this.fail(error); }
    }
    private act(action: Action, verify: (after: Observation) => boolean, timeout = 18_000): void {
        const s = this.observation;
        if (this.state !== 'running' || this.pendingAction || !s?.ready || s.account !== this.account || !s.account) return;
        const deadline = Date.now() + Math.max(1200, Math.min(timeout, 60_000));
        const result: ActionResult = { id: ++this.actionId, action, state: 'dispatched', reason: '', before: s.sequence, after: s.sequence };
        const response = this.game.dispatch({ action, sequence: s.sequence, account: s.account, deadline });
        result.reason = response.reason;
        if (!response.accepted) result.state = 'blocked';
        this.lastResult = result;
        this.recorder.record('automated-command', { ...result }, s);
        if (response.accepted) { this.issuedAction = true; this.pendingAction = { result, before: s, verify, deadline, noticed: false }; }
        else { this.retries++; this.remember(result); this.log(response.reason, 'warn'); }
    }
    pump(now = Date.now()): void {
        try {
            const previous = this.observation;
            const s = this.game.observe(); this.observation = s; this.recorder.observe(s);
            if (this.state !== 'running') { this.previousPump = now; return; }
            if (this.previousPump && now - this.previousPump > 5000) { this.pause('Browser suspended; inspect the character and Resume'); return; }
            if (!s.ready || s.account !== this.account) { this.pause('Connection or scene changed; inspect and Resume'); return; }
            if (previous?.ready && s.health < previous.health) { this.pause('Health decreased; player attention required'); return; }
            this.progress.elapsed += Math.max(0, now - this.previousPump); this.previousPump = now;
            const pending = this.pendingAction;
            if (pending) {
                pending.result.after = s.sequence;
                if (s.sequence > pending.before.sequence && pending.verify(s)) this.settle('success', 'Verified by client observation', s);
                else if (now >= pending.deadline) this.settle('timeout', 'No verified result before deadline', s);
                else if (!pending.noticed) {
                    pending.noticed = true; pending.result.state = 'pending';
                    this.recorder.record('action-pending', { ...pending.result }, pending.before, s);
                }
            }
            if (!this.pendingAction && this.context && this.script) this.script.onTick(this.context, s);
            if (now - this.lastSave > 3000) this.save();
        } catch (error) { this.fail(error); }
    }
    private settle(state: ActionResult['state'], reason: string, after = this.observation): void {
        const pending = this.pendingAction; if (!pending) return;
        this.lastResult = { ...pending.result, state, reason, after: after?.sequence ?? pending.result.after };
        this.pendingAction = null;
        this.remember(this.lastResult);
        this.recorder.record('action-result', this.lastResult, pending.before, after ?? undefined);
        if (state === 'success') { this.lastSuccess = this.lastResult; this.log(`${pending.result.action.kind}: verified`); }
        else { this.retries++; this.log(`${pending.result.action.kind}: ${reason}`, 'warn'); }
    }
    private remember(result: ActionResult): void {
        this.recentResults.push({ ...result });
        if (this.recentResults.length > 50) this.recentResults.shift();
    }
    pause(reason = 'Paused by player', halt = true): void {
        if (this.state !== 'running') return;
        this.state = 'paused'; this.status = reason; this.settle('interrupted', reason);
        if (halt) this.halt();
        try { this.script?.onPause?.(reason); } catch (error) { this.log(String(error), 'error'); }
        this.log(reason); this.recorder.record('paused', { reason }); this.save();
    }
    resume(): void {
        if (this.state !== 'paused') return;
        const s = this.game.observe(); this.observation = s;
        if (!s.ready || s.account !== this.account) throw new Error('The original character must be logged in with a ready scene');
        this.script?.onResume?.(s); this.state = 'running'; this.previousPump = Date.now();
        this.status = 'Reconciling current inventory and position'; this.lastResult = null;
        this.log('Resumed after fresh observation'); this.recorder.record('resumed', {}, undefined, s); this.save();
    }
    stop(reason = 'Stopped by player'): void { this.finish('stopped', reason); }
    private finish(state: RunnerState, reason: string): void {
        this.state = state; this.status = reason; this.settle('interrupted', reason); this.halt();
        try { this.script?.onStop?.(reason); } catch (error) { this.log(String(error), 'error'); }
        this.script = null; this.log(reason); this.recorder.record(state, { reason, progress: this.progress });
        if (this.account) this.store.clear(this.account);
    }
    private halt(): void {
        if (!this.issuedAction) return;
        let s: Observation;
        try { s = this.game.observe(); this.observation = s; } catch { return; }
        // A native movement click cancels a server action. Never queue a future cancellation or overwrite later manual input.
        if (s.ready && s.position && s.account === this.account && s.bank === null) {
            this.game.dispatch({ action: { kind: 'walk', tile: s.position }, sequence: s.sequence, account: s.account!, deadline: Date.now() + 1200 });
        }
    }
    private fail(error: unknown): void { this.finish('error', error instanceof Error ? error.message : String(error)); this.log(this.status, 'error'); }
    save(): void {
        this.lastSave = Date.now();
        if (this.account && this.meta && (this.state === 'running' || this.state === 'paused')) {
            if (!this.store.save(this.account, { version: 1, script: this.meta.id, settings: this.settings, progress: this.progress, savedAt: Date.now() })) this.log('Objective storage unavailable', 'warn');
        }
    }
    exportDiagnostics(): string {
        return JSON.stringify({ schema: 'hallumina-diagnostics-v1', revision: 254, state: this.state, status: this.status,
            script: this.meta?.id, settings: this.settings, progress: this.progress, retries: this.retries,
            lastResult: this.lastResult, lastSuccess: this.lastSuccess, recentResults: this.recentResults, logs: this.logs }, null, 2);
    }
}
