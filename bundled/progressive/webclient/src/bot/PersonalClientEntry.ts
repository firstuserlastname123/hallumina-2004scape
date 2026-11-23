import { Client as NativeClient } from '../client/ClientEntry.js';
import { R254Adapter } from './adapter/R254Adapter.js';
import { ScriptRegistry } from './runtime/ScriptRegistry.js';
import { ScriptRunner } from './runtime/ScriptRunner.js';
import { Recorder } from './runtime/Recorder.js';
import { ObjectiveStore } from './runtime/ObjectiveStore.js';
import { woodcutting } from './scripts/Woodcutting.js';
import { BotPanel } from './panel/BotPanel.js';
export class Client extends NativeClient {
    readonly personalController: ScriptRunner;
    constructor(node: number, lowmem: boolean, members: boolean) {
        super(node, lowmem, members);
        const port = new R254Adapter(this), registry = new ScriptRegistry(); registry.register(woodcutting);
        let storage: Storage | null = null; try { storage = localStorage; } catch { /* In-memory play still works. */ }
        const store = new ObjectiveStore(storage, `${location.origin}${location.pathname}:world-${node}`);
        const runner = new ScriptRunner(port, new Recorder(), store), panel = new BotPanel(runner, registry);
        this.personalController = runner;
        const canvas = document.getElementById('canvas');
        const takeover = () => runner.pause('Manual input; player has control');
        const remove = port.onManualCommand(action => {
            runner.pause('Manual command; player has control', false);
            runner.recorder.record('manual-command', action, runner.observation ?? undefined);
        });
        for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel']) canvas?.addEventListener(type, takeover, { capture: true, passive: true });
        const visibility = () => { if (document.hidden) runner.pause('Tab hidden; inspect and Resume when ready'); };
        document.addEventListener('visibilitychange', visibility);
        const pump = () => { runner.pump(); panel.render(); };
        let timer = setInterval(pump, 600);
        window.addEventListener('pageshow', event => {
            if (event.persisted) { timer = setInterval(pump, 600); pump(); }
        });
        window.addEventListener('pagehide', event => {
            runner.pause('Page closed'); runner.save(); clearInterval(timer);
            if (event.persisted) return; // A restored page keeps its paused UI and adapter.
            remove(); port.dispose();
            document.removeEventListener('visibilitychange', visibility);
            for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel']) canvas?.removeEventListener(type, takeover, true);
        });
    }
}
