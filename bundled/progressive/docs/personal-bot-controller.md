# Personal bot controller (r254)

The optional browser client adds a compact dark sidebar to Hallumina's existing
r254 game. It controls the ordinary character logged into that tab. Authentication
stays in the native game login screen. The standard client and the default 100
managed playerbots keep their existing behavior.

## Build and open

Use an assembled Progressive runtime, with the bundled overlay applied by the
launcher (`node launcher/launcher.js --build progressive-254`). Do not run test
worlds against the runtime's database or player saves.

From that runtime's `webclient` directory, install its dependencies with Bun and
run `bun run build:personal` to build only the optional bundle. `bun run build`
builds all client entries. Set the existing `LOGIN_RSAE`, `LOGIN_RSAN` and
`SECURE_ORIGIN` build variables as appropriate for your server, just as for the
standard client. The build additionally writes `out/personal-client.js`, its
source map, and `out/personal-client.NOTICE.txt`. The normal client entry does
not import the personal controller.

Start Hallumina normally. On its existing localhost game page, choose **Personal
bot client**, or append `personalBot=1` to that page's query string, for example
`http://localhost:8888/rs2.cgi?lowmem=1&personalBot=1` (use your configured port).
The link preserves existing world and memory parameters. **Standard client**
returns to ordinary play. No server revision change or separate controller
service is required.

Hallumina's launcher sets `NODE_CLIENT_ROUTEFINDER=false`, matching its native
client's server-routed movement. Keep that existing setting when launching the
engine manually; the upstream engine's generic default is different.

## Woodcutting

Complete Tutorial Island normally, bring an axe, and travel to the ground floor
near Draynor bank. Start within 30 tiles of `(3102,3240,0)`. The first supported
location contains normal **Tree** objects within 18 tiles of that centre; oaks,
willows, other banks, distant travel, quests and combat are outside this script.

Use the library's search and category filter, select **Woodcutting**, then
**Start**. Configure the log target, maximum active minutes, and banking. Set
the target to zero for a duration-only objective. The earlier of quantity or
duration ends gathering. With banking enabled, remaining logs are deposited
before completion. Without banking, a full inventory ends the run.

The script checks your usable axe and Woodcutting level. It checks native scene
collision before selecting a tree, waits for actual logs and XP, avoids repeated
clicks while gathering, and temporarily excludes failed targets. It waits up to
one minute for reachable trees to respawn. Three unsuccessful actions pause for
inspection. Doors, unexpected dialogue, random events, health loss and travel
outside the supported area may require manual attention. Only native Woodcutting
level-up continuations are handled automatically.

Validated interactions and observed movement/XP progress refresh the native
client's input-idle timer while the script runs. Paused or inactive automation
does not keep the character logged in indefinitely.

Banking uses a reachable Draynor booth's **Use-quickly** option, the actual bank
interface, and its **Deposit All** operation for normal logs (1511). A deposit is
verified only when logs decrease in inventory and increase in the open bank.
Axes, equipped items and every other inventory item are protected. The script
closes the bank, chooses a reachable tree and continues. A full bank, blocked
approach, missing axe or inventory full of protected items never causes a drop,
item grant, teleport or privileged action.

## Control and persistence

**Pause** cancels pending controller work and sends an ordinary movement click to
the character's current tile to stop ongoing gathering/travel where possible.
**Resume** obtains a fresh observation and reconciles the current inventory and
position. **Stop** ends the objective. Already processed server actions cannot be
undone; a late native item reward can still arrive after cancellation.

Pointer, touch, wheel and keyboard input on the game canvas take priority and
pause the controller before the game processes that input. Manual native commands
also pause it. Input is not prevented or intercepted for automation. Explicit
**Resume** is required after taking control, logout, a scene rebuild, a hidden tab,
health loss, or a browser scheduling gap over five seconds. This is intentionally
conservative; it does not fight the player or automatically log in again.

Non-sensitive preferences and a versioned objective checkpoint use browser local
storage, scoped by origin, game path, world number and account. An objective stores
the script ID, validated settings, gathered/banked counts and active elapsed time.
It stores no credentials, packets, login state or invented character inventory.
Storage denial leaves in-memory play available and produces a diagnostic warning.

After a reload and native login, **Restore saved objective…** lets the player review
parameters and explicitly start the restored objective. A restored run reads the
current character state before acting. If a deposit completed before confirmation
was lost, the now-empty log inventory is not deposited again. Rewards earned while
paused or between the last checkpoint and a crash are conservatively excluded
from the objective counter. Inspect your actual inventory and bank when recovering.

The browser cannot keep playing after the tab closes or guarantee uninterrupted
background execution. Recordings are in memory and should be exported before
leaving. No persistent external controller is implemented.

## Recording and diagnostics

Enable **Record gameplay events** independently of running a script. The recorder
keeps commands separate from observed changes and records manual movement, NPC and
object options, inventory actions/dialogue components, inventory/equipment changes,
XP/level changes, interface transitions, client-visible quest varps, automated action
results, retries and cancellation. Each event has a timestamp and monotonic
sequence. Observed results/action outcomes carry before/after evidence where
available. Polling can coalesce several changes within one 600 ms sample; this is
not a packet recorder or an exact replay of every server tick.

**Export events** downloads versioned JSON; **Clear events** clears this tab's
buffer. Recording is off by default and is bounded by 1,500 events and approximately
4 MiB of serialized UTF-16 data. Oldest events are discarded and the export reports
the discarded count. Exported gameplay can reveal locations, inventory and quest
progress; share it deliberately. The recorder uses an explicit observation-field
allowlist and never reads authentication packets, passwords, session values,
private keys, chat messages, or unrelated browser data.

Diagnostics show state, objective/target, live character activity, counts, bank
deposits, elapsed active time, last action/result, last success and retry count.
Logs retain at most 200 entries and have an Info/Warn/Error verbosity selector.
The runtime also retains the last 50 typed terminal action results.
**Export diagnostics** downloads a separate bounded diagnostic JSON file. Nothing
depends on `NODE_DEBUG` or the managed-playerbot debug service.

## Architecture and future scripts

The primary reference is [rs2b0t](https://github.com/rs2b2t/rs2b0t), pinned at
`27e57fa331656df5a0d9b7b1cd1f4ec0c44519bb`. Inspected implementations:

| Reference | Hallumina adaptation |
| --- | --- |
| `panel/BotPanel.ts` | Compact sidebar, lifecycle controls, separate diagnostics and paced rendering |
| `panel/ScriptLibrary.ts` | Search by metadata/tags and category, selectable script cards |
| `panel/ParamsModal.ts` | Generated accessible controls from each script's settings schema |
| `runtime/ScriptRegistry.ts`, `defineBot.ts` | Metadata/factory registry, explicit built-in registration |
| `runtime/Settings.ts` | Typed primitive schemas, defaults and strict runtime validation |
| `runtime/ScriptRunner.ts` | One active lifecycle, readiness guards, pause/resume/stop and bounded outcomes |
| `api/bot/Bot.ts` | Typed start/tick/pause/resume/stop contract, separated from client bindings |

Small registry/manifest/settings structures and UI patterns are selectively adapted
under MIT; the complete copyright and license notice is in `webclient/src/bot/NOTICE`
and shipped beside the output bundle. Hallumina implements its own r254 adapter,
collision checks, recorder, objective reconciliation and woodcutting/banking logic.
No r289 client, incompatible protocol, server catalog, external loader, upstream
quest script, account manager or multibox implementation is transplanted.

Add a built-in script with `defineBot`, a metadata/settings schema and a factory
implementing `BotScript`; register it in `PersonalClientEntry.ts`. UI changes are
not needed for another script's parameters. Script callbacks are synchronous and
bounded. They call `ScriptContext.act` and wait for fresh observations, rather than
creating timers or reaching into client internals.

`api/Types.ts` defines versioned observations and native actions. `R254Adapter`
alone binds private r254 fields and dispatches through native `doAction`/`tryMove`.
It validates account, observation sequence/age, deadline, floor, scene, available
options, visible interfaces, inventory slots and collision routes. The runner
allows one pending action and distinguishes **dispatched**, **pending**,
**success**, **blocked**, **interrupted** and **timeout**. Sending a click is never
proof of success. The caller supplies a bounded verification predicate.

Observations include position, inventory/equipment, stats/XP, nearby NPCs/objects/
ground items, options and open interfaces. Quest observations are limited to varps
referenced by native quest-journal scripts; server-only quest/tutorial state is not
exposed or invented. This is an internal typed foundation for a future external
agent. There is no remote transport, Strata integration, server-managed AI
conversation, arbitrary script loading or multiboxing in this change.

## Validation

Run from an assembled runtime with the overlay applied:

```sh
cd webclient
bun run build:personal
node node_modules/typescript/lib/tsc.js --noEmit
node --import ../engine/node_modules/tsx/dist/loader.mjs --test tests/personal-bot.test.ts
cd ../engine
node --import tsx --test tests/build-integrity.test.ts tests/bot-reliability.test.ts tests/bot-runtime.test.ts tests/bot-melee.test.ts tests/player-save.test.ts tests/persistence-runtime.test.ts
```

The optional full browser suite requires Docker and separately installed
`playwright-core`; neither is a production dependency:

```sh
PERSONAL_BOT_RESULTS=/tmp/personal-controller-results.json \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
node tools/experiments/personal-controller-smoke.mjs
```

The launcher retains PR #7's network-none container, read-only root, dropped
capabilities, no-new-privileges and anonymous disposable volume. It copies code,
assets and content, creates a new SQLite database and ordinary test accounts, and
does not mount the source runtime, existing saves or Docker socket into the
container. Listeners are loopback-only; management and content-edit routes are
disabled and probed. It hashes the source content/data/database before and after.
The gameplay driver finishes the actual Tutorial Island requirements via native
actions before travelling to Draynor. The test world's read-only observer checks
tutorial stages, population, timings and persistence; the product does not use it.

Actual validation results are recorded below after the browser run completes.
