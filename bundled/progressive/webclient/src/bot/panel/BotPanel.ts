import type { ScriptRegistry, ScriptMeta } from '../runtime/ScriptRegistry.js';
import type { ScriptRunner } from '../runtime/ScriptRunner.js';
import { ParamsModal } from './ParamsModal.js';
import { ScriptLibrary } from './ScriptLibrary.js';
import { el, button, download } from './dom.js';
import { css } from './style.js';
export class BotPanel {
    readonly root = el('aside', '', 'hb-panel');
    private selected: ScriptMeta | undefined;
    private readonly params = new ParamsModal();
    private readonly status = el('p', '', 'hb-status');
    private readonly stats = el('dl');
    private readonly inventory = el('p');
    private readonly log = el('pre');
    private readonly notice = el('p', '', 'hb-muted');
    private readonly error = el('p', '', 'hb-error');
    private readonly recordLabel = el('span');
    private readonly start: HTMLButtonElement;
    private readonly pause: HTMLButtonElement;
    private readonly resume: HTMLButtonElement;
    private readonly stop: HTMLButtonElement;
    private readonly restore: HTMLButtonElement;
    constructor(private readonly runner: ScriptRunner, registry: ScriptRegistry) {
        const style = el('style'); style.textContent = css; document.head.append(style);
        this.root.setAttribute('aria-label', 'Personal bot controller');
        this.root.append(el('h2', 'Hallumina'), el('p', 'PERSONAL BOT · r254', 'hb-muted'), this.status, this.error);
        this.status.setAttribute('role', 'status'); this.error.setAttribute('role', 'alert');
        this.selected = registry.list()[0];
        const controls = el('div', '', 'hb-row');
        const safe = (fn: () => void) => () => { try { this.error.textContent = ''; fn(); } catch (e) { this.error.textContent = e instanceof Error ? e.message : String(e); } this.render(); };
        this.start = button('Start', safe(() => {
            if (!this.selected) return;
            this.params.open(this.selected, this.runner.store.preferences(this.runner.observation!.account!, this.selected.id), values => this.runner.start(this.selected!, values));
        }));
        this.pause = button('Pause', safe(() => runner.pause())); this.resume = button('Resume', safe(() => runner.resume())); this.stop = button('Stop', safe(() => runner.stop()));
        controls.append(this.start, this.pause, this.resume, this.stop);
        this.restore = button('Restore saved objective…', safe(() => {
            const account = runner.observation?.account; if (!account) return;
            const saved = runner.store.load(account), meta = saved && registry.get(saved.script);
            if (saved && meta) this.params.open(meta, saved.settings, values => runner.start(meta, values, saved));
        }));
        this.root.append(controls, this.restore, this.notice, this.stats);
        const library = new ScriptLibrary(registry, meta => { this.selected = meta; this.notice.textContent = `Selected: ${meta.name}`; });
        this.root.append(library.root);
        const inv = el('details'); inv.append(el('summary', 'Inventory & equipment'), this.inventory); this.root.append(inv);
        const diagnostics = el('section'); diagnostics.append(el('h3', 'Diagnostics'));
        const verbosity = el('select'); verbosity.setAttribute('aria-label', 'Log verbosity');
        for (const level of ['info', 'warn', 'error'] as const) { const option = el('option', `${level} logs`); option.value = level; verbosity.append(option); }
        verbosity.addEventListener('change', () => { runner.verbosity = verbosity.value as typeof runner.verbosity; });
        diagnostics.append(verbosity, this.log, button('Export diagnostics', () => download('hallumina-diagnostics.json', runner.exportDiagnostics()))); this.root.append(diagnostics);
        const recording = el('section'), label = el('label'), checkbox = el('input'); checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => { runner.recorder.setEnabled(checkbox.checked); this.render(); });
        label.append(checkbox, el('span', 'Record gameplay events')); recording.append(el('h3', 'Event recorder'), label, this.recordLabel,
            button('Export events', () => download('hallumina-events.json', runner.recorder.export())), button('Clear events', () => { runner.recorder.clear(); this.render(); }),
            el('p', 'Recording is off by default and stays in this tab. Manual play is recorded even when no script is running.', 'hb-muted'));
        this.root.append(recording, el('p', 'Game input takes control and pauses automation. Resume explicitly after inspecting the character.', 'hb-muted'));
        const game = document.getElementById('game');
        if (game) { const shell = el('div'); shell.id = 'personal-shell'; game.before(shell); shell.append(game, this.root); }
        this.render();
    }
    render(): void {
        const r = this.runner, s = r.observation, active = r.state === 'running' || r.state === 'paused';
        this.status.textContent = `${r.state.toUpperCase()} · ${r.status}`;
        this.start.disabled = active || !s?.ready; this.pause.disabled = r.state !== 'running'; this.resume.disabled = r.state !== 'paused'; this.stop.disabled = !active;
        this.restore.hidden = active || !s?.account || !r.store.load(s.account);
        this.notice.textContent = !s?.ready ? 'Log in through the game to use scripts.' : `Selected: ${this.selected?.name ?? 'None'}`;
        const stats = { Character: s?.account ?? 'Offline', Position: s?.position ? `${s.position.x}, ${s.position.z} · floor ${s.position.level}` : '—',
            Activity: s?.moving ? 'Moving' : s?.animation !== -1 ? `Animation ${s?.animation}` : 'Idle',
            Woodcutting: s?.skills[8] ? `Lv ${s.skills[8].base} · ${s.skills[8].xp} XP` : '—',
            Objective: r.meta ? `${r.progress.gathered} / ${r.settings.target || 'duration'} logs` : '—',
            Banked: `${r.progress.banked} · ${r.progress.cycles} deposits`, Time: `${Math.floor(r.progress.elapsed / 60_000)}m ${Math.floor(r.progress.elapsed / 1000) % 60}s`,
            Actions: `${r.lastResult?.action.kind ?? '—'} · ${r.lastResult?.state ?? '—'}`, 'Last success': r.lastSuccess?.action.kind ?? '—', Retries: String(r.retries) };
        this.stats.replaceChildren(...Object.entries(stats).flatMap(([key, value]) => [el('dt', key), el('dd', value)]));
        this.inventory.textContent = `${s?.inventory.length ?? 0}/28 slots. ${s?.inventory.map(i => `${i.count} ${i.name}`).join(', ') || 'Empty'}. Equipped: ${s?.equipment.map(i => i.name).join(', ') || 'None'}`;
        this.log.textContent = r.logs.slice(-30).map(l => `${new Date(l.at).toLocaleTimeString()} ${l.level} ${l.message}`).join('\n') || 'No script activity yet.';
        this.recordLabel.textContent = ` ${r.recorder.count} events · ${r.recorder.dropped} discarded `;
    }
}
