# Playerbot navigation and task reliability (r254)

For the latest reachability, native obstacle recovery and paired population validation, see [Intelligent navigation](playerbot-intelligent-navigation.md).

For the current melee encounter behavior, native XP measurements and r254 regression commands, see [Melee combat reliability](playerbot-melee-combat.md).

This change targets `dev` at `1df577575837b7fb07900bf84402a5921dbe2182`.
The original 9,000-line attachment was unavailable in this workspace. The supplied excerpt and counts (4,615 oscillations, 161 timeout messages, 80 failed sheep searches) are diagnostic references, not the baseline for the measurements below.

## Defects and repairs

- **Stationary positions were treated as oscillation.** The old monitor appended positions without walking intent and accepted repeated identical coordinates as both period-2 and period-3 cycles. `BotPlayer` checked oscillation even without a route. Recovery reset history, producing the reported six-tick loop. History now requires an eligible walking attempt, at least two distinct positions in a repeated movement cycle, and three full cycles. Idle gaps, script delays and floor changes break history. A stationary walking attempt instead reaches the ten-tick stuck threshold. Genuine cycles still trigger recovery.
- **Movement snapshots missed early returns.** Dialogs, subtasks, teleports and planning branches skipped the end-of-tick waypoint snapshot. A `finally` block now records intent on every exit; delayed scripts and pending teleports pause monitoring.
- **Some fallback paths offered no usable movement.** rsmod returns compressed turn points in execution order, with the destination last; the old CSV trimmer traversed them backwards and checked only turn points. Trimming now checks tiles between turns and preserves the reachable prefix. Zero-movement paths are rejected. The final single-step fallback checks directional collision as well as the CSV. Destination changes cancel stale routes while preserving pending gate operations.
- **Repeated failure needed a task-level exit.** Routes back off for 4/8/16/32 ticks and defer their task for 200 ticks after four failures without observed progress. Merely queuing a route does not count as progress. A 100-tick distance watchdog also catches longer detours that do not approach the destination. Missing requirements and task exceptions receive a temporary deferral. Weighted planners exclude deferred activities until expiry; specialized personalities wait and retry their own activity. Personality weights and definitions are unchanged.
- **Combat retries could defeat the approach timeout.** A 12-tick re-engage reset the 20-tick approach counter. Re-engaging now preserves that counter; distant targets that time out are excluded for 100 ticks, and their interaction/claim is released. After 300 active non-banking ticks without combat XP, the task yields to the planner. Ordinary adjacent combat and successful hits retain their existing behavior.
- **Sheep depletion caused repeated searches at the same coordinate.** A sheep remains shorn for 100 ticks. Searches now back off with per-bot spacing, rotate live sheep, preserve pending interactions, and allow a full regrowth window. After 160 ticks without wool, bots spin a partial batch or defer crafting and select another activity. Queuing a shear is not treated as obtaining wool. NPC searches exclude inactive entities. No fallback creates wool or awards XP for failed searches.

The revision, checksum baselines, reward formulas, initial equipment, personalities, save format and SQLite schema are unchanged. `Player.addXp` only gains an observational callback for population statistics. Preset PK profiles and loaded XP are excluded from progression measurements.

## Review corrections: destination jitter and subtask ownership

The follow-up keeps the stationary-activity fix, collision checks, logging controls and existing game mechanics. Production corrections are limited to `BotAction.ts`, `BotRouteRetry.ts` and `BotPlayer.ts`.

- Nearby requests within four tiles of a **stable** route anchor reuse an active route. The latest requested tile is considered when that route ends. Accumulated target movement beyond that radius or a floor change still retargets, and pending gate operations remain intact.
- Both small jitter and large retargets preserve the current task's failure count and backoff. Progress is evaluated against the previous anchor before accepting a new one. A target moving closer to a stationary bot, or a request for the bot's current tile, cannot replenish retries. Actual travel toward the goal or actual arrival can replenish them; a short local arrival is credited once, rather than on every stationary tick. Successful task changes still start a new task-owned budget.
- Parent tasks and subtasks have separate navigation state. Failure messages identify the active task. Calls made while a child is ticking remain attributed to that child, including its abort/exception path. An aborted child cannot queue a new route through its interrupted callback.
- A failed/interrupted child releases its queued action, route and task-owned claims. The child receives a 200-tick retry cooldown; the parent retains its own retry budget and resumes. Child completion resumes the parent normally, and interrupted parents release the child before goal selection.
- `setSubTask` now returns whether scheduling succeeded. It refuses duplicate/replacement requests while a child is active, during that child's cooldown, while the parent is interrupted, or until the parent/planner has had a turn after a child exits. Renaming a child therefore cannot bypass the parent turn. A child is limited to 300 active task-tick calls; ordinary engine dialog/teleport processing retains its existing priority.

Targeted native-engine checks cover the actual `BankstandTask.handleWalk` call site, preservation of queued waypoint arrays, large destination changes, a moving destination, gate preservation, dynamic collision removal, exhausted randomized child routes, repeated child scheduling, cooldown expiry, interrupted/exceptional children, parent resumption, and resumption of the planner when no parent exists.

## Console configuration

Console logging is independent of the web bot debugger. Add settings to `engine/.env` and restart:

| Setting | Default | Meaning |
| --- | --- | --- |
| `BOT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `off` |
| `BOT_LOG_RATE_TICKS` | `100` | Minimum spacing per bot/event key; `0` prints every enabled event |
| `BOT_LOG_SUMMARY_TICKS` | `100` | Population summary spacing; `0` disables summaries |
| `BOT_LOG_DETAILS` | `false` | Optional one-line bot snapshots at summary time; requires `debug` |

One production tick remains **600ms**. Default summaries arrive every 60 seconds. Routine per-bot/task diagnostics use `debug`; navigation failures, unavailable resources and recovery/deferral events use `warn`. Repeated enabled events include their suppressed-repeat count on the next emission. Cumulative event counters include filtered and rate-limited events. Summary output follows its own configured interval, independently of the repeat limiter. The repeat cache is capped at 4,096 entries.

Each population summary includes active/configured bots, task counts, world and bot mean/p95/max processing time, world ticks exceeding 600ms, cumulative XP and level gains through `addXp`, recovery counts and rate-limited output count. Timing samples are bounded to 600 recent ticks for p95; mean/max/overruns cover the entire summary window. Full ASCII status dumps are replaced by this summary. Existing database/startup exceptions retain their stack traces.

To investigate an incident, use `BOT_LOG_LEVEL=debug` and a shorter rate interval (or `0` for a bounded capture). Keep the periodic summary to compare raw failure counts with output volume. Changing severity never changes navigation or task recovery.

## Reproduce the simulations

Use two **disposable** assembled runtimes, one from the base commit and one from this branch. Do not copy player saves or a human database into them. The compact launcher can assemble each fresh checkout:

```sh
node launcher/launcher.js --build progressive-254
cd runtime/active/engine
npm ci
node --import tsx tools/server/setup.ts
# Select "Set up as a development world" to initialize SQLite.
npm run build
```

Copy this branch's `engine/tools/bot/simulate.ts` into the baseline runtime at the same relative path, `tools/bot/simulate.ts`. The harness supports both versions. In each runtime:

```sh
touch .bot-simulation-runtime
NODE_PROFILE=bot-simulation DB_BACKEND=sqlite NODE_PRODUCTION=true \
ENGINE_REVISION=254 NODE_XPRATE=1 NODE_PROGRESSIVE_XP=false \
BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true \
BOT_DEBUG_ENABLED=false BOT_LOG_LEVEL=info BOT_LOG_RATE_TICKS=100 \
BOT_LOG_SUMMARY_TICKS=100 BOT_SIM_SEED=254 BOT_SIM_TICKS=6000 \
BOT_SIM_INTERVAL_MS=0 BOT_SIM_OUTPUT=/absolute/path/results.json \
node --import tsx tools/bot/simulate.ts > /absolute/path/gameplay.log \
2> /absolute/path/progress.log
wc -l -c /absolute/path/gameplay.log
```

The harness refuses an existing simulation save profile, a database with human accounts, a missing disposable-runtime marker, another revision, or a population other than 100 configured bots. Start again from a fresh disposable runtime for another run.

`BOT_SIM_INTERVAL_MS=0` condenses waiting time **only in the harness**; every engine, NPC, script, collision, inventory and bot tick still runs. 6,000 ticks represent 60 minutes of game time, not 60 minutes of wall time. Use `BOT_SIM_INTERVAL_MS=600` on the Ubuntu VirtualBox host for a paced one-hour validation. Neither mode changes the production tick constant, XP rate or progression rules.

The JSON report records full-population samples every 1,000 ticks, timing distributions, action XP/levels, observed tasks, and each bot's ending stats. XP is counted at actual `addXp` calls after the first 20 initialization ticks, so PK profile assignments cannot appear as earned XP. Navigation recovery counts are observed before log filtering. Timeout diagnostics are observed before both the old wall-clock log throttle and the new severity/rate filter; emitted timeout lines are reported separately. Resource failures use raw event counts in the new version. At completion, the normal engine logout queue flushes all 100 saves; the harness checks save CRCs, reloads stats/coordinates/permanent inventories, and runs SQLite `quick_check`.

## Revised comparison after review

The revised experiment reruns **all three implementations** with the same harness: the original `dev` baseline (`1df5775`), the previous PR implementation (`cb4f778`), and these corrections. Each implementation runs seeds 254 and 255 for 6,000 full world ticks with 100 bots, fresh SQLite databases, and fresh save profiles. All six runs are sequential. The three corrected production files are fingerprinted in each report, so the measured working tree can be matched to the submitted changes.

The harness additionally counts queued routes, clears of active routes, raw path/progress failures, main/child deferrals and accepted subtask scheduling. Queued routes include the engine's interaction paths; they are not a count of all failed BFS attempts. Original-baseline deferral/path-budget metrics are unavailable because those mechanisms did not exist. Emitted lines and raw failures remain separate metrics.

[Machine-readable revised results](playerbot-review-simulation-results.json) include all raw counters, source fingerprints, cohorts and 1,000-tick samples. Each corrected source fingerprint matches the submitted production files.

All six reported runs retained 100 active bots and passed all 600 save CRC/stat/coordinate/permanent-inventory round trips. SQLite retained 100 accounts per database and returned `ok` in every integrity check. All 52 progression bots earned XP in every run.

| Metric | 254 original | 254 previous PR | 254 corrected | 255 original | 255 previous PR | 255 corrected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Oscillation recoveries | 63,877 | 226 | 100 | 65,813 | 154 | 104 |
| Stationary-only oscillations | 53,790 | 0 | 0 | 56,067 | 0 | 0 |
| Walking-stuck recoveries | 0 | 509 | 614 | 0 | 561 | 635 |
| Raw path failures | n/a | 607 | 427 | n/a | 726 | 439 |
| No-progress failures | n/a | 14 | 24 | n/a | 12 | 18 |
| Main task deferrals | n/a | 116 | 182 | n/a | 147 | 185 |
| Raw timeout diagnostics | 2,086 | 1,460 | 1,151 | 2,037 | 1,302 | 1,174 |
| Raw failed sheep searches | 1,486 | 150 | 136 | 262 | 24 | 113 |
| Queued routes, engine + bot | 29,528 | 44,204 | 42,353 | 28,782 | 42,161 | 39,270 |
| Clears of active routes | 7,417 | 23,684 | 18,734 | 7,421 | 21,995 | 17,028 |
| Emitted console lines | 160,708 | 1,298 | 1,404 | 160,199 | 1,235 | 1,348 |
| Console bytes | 15,573,125 | 173,287 | 191,110 | 16,238,789 | 167,699 | 185,437 |
| Progression-bot earned XP | 84,186.5 | 75,239.8 | 82,364.0 | 79,191.8 | 76,979.1 | 75,138.0 |
| All-bot action XP | 272,012.4 | 271,260.9 | 299,178.5 | 244,866.0 | 244,670.4 | 216,149.1 |
| Level gains | 599 | 569 | 600 | 589 | 577 | 565 |

| Processing time | 254 original | 254 previous PR | 254 corrected | 255 original | 255 previous PR | 255 corrected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Steady world mean / p95 / max (ms) | 17.75 / 27.10 / 331.08 | 19.97 / 31.24 / 288.57 | 19.20 / 27.82 / 429.33 | 17.80 / 26.36 / 384.26 | 19.32 / 28.20 / 326.23 | 19.81 / 28.72 / 361.68 |
| Steady bot mean / p95 (ms) | 5.65 / 11.90 | 7.61 / 15.03 | 7.32 / 14.03 | 5.53 / 11.18 | 7.04 / 13.53 | 7.21 / 13.73 |
| World startup-inclusive max (ms) | 3988.59 | 4077.81 | 3933.24 | 3968.83 | 4306.27 | 3884.35 |
| World ticks over 600ms, startup / steady | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |
| Wall seconds, including save checks | 117.94 | 131.38 | 126.51 | 118.21 | 127.52 | 130.06 |

Across seeds, corrected raw path failures were 866 versus 1,333 in the previous PR (-35.0%). Active-route clears were 35,762 versus 45,679 (-21.7%). Deferrals rose from 263 to 367: failure budgets now exhaust instead of being replenished by changed coordinates. These counts include native interaction routes and differing task mixes.

Combined progression-bot XP was 157,502.0: +3.5% versus the previous PR and -3.6% versus the original baseline. Individual seed results differ, and total action XP includes PK combat. No XP reward, multiplier or personality weight changed. This is not evidence of a universal throughput improvement.

Limitations: corrected raw walking-stuck counts, sheep-search failures and console volume can be higher than the previous PR; the tables retain those results. More bounded deferrals and task-owner labels increase warning volume. Mean processing cost remains above the original baseline and varies against the previous PR by seed. No steady tick exceeded 600ms; startup-inclusive outliers remain reported. These are accelerated managed-host simulations, not paced Ubuntu VirtualBox measurements.

All six population runs scheduled **zero subtasks**. They measure normal-population navigation/task behavior, not subtask recovery throughput. Subtask failure attribution, bounded priority, cleanup and successful parent/planner resumption are validated by the dedicated real-engine fixture, including an actually enclosed destination. The three focused retry regressions also fail against `cb4f778` and pass against the corrected implementation.

The initial four-run report below is retained as historical evidence. It must not be combined with the revised experiment as if all runs were the same paired workload. Existing wall-clock timers and shared random-number consumption produce different trajectories even with the same initial seed. Accelerated world ticks do not validate real-time VM scheduling, browser/network load, or a multi-day soak.

## Initial PR simulation results (historical)

Final sequential run results are recorded in `playerbot-simulation-results.json` alongside this document. These are managed Linux/Node 24.22.1 measurements, not measurements from the user's Ubuntu 26.04 VirtualBox guest. All configured personality groups participate: 52 progressing bots and 48 specialized PKer, vendor and social bots.

Both seeds ran sequentially, with a fresh database and save profile for every run. Each version processed 12,000 ticks across the two seeds (two hours of game time). All 400 save round trips passed, all databases retained 100 bot accounts, and SQLite checks returned `ok`.

| Metric | Seed 254 before | Seed 254 after | Seed 255 before | Seed 255 after |
| --- | ---: | ---: | ---: | ---: |
| Active bots | 100 | 100 | 100 | 100 |
| Oscillation recoveries | 64,712 | 206 | 65,253 | 246 |
| Stationary-only oscillation recoveries (lower bound) | 54,362 | 0 | 55,752 | 0 |
| Walking-stuck recoveries | 0 | 566 | 0 | 532 |
| Raw timeout diagnostics | 1,986 | 1,498 | 1,925 | 1,373 |
| Raw failed sheep searches | 1,202 | 182 | 160 | 57 |
| Emitted console lines | 146,614 | 1,323 | 153,589 | 1,208 |
| Console output bytes | 14,519,467 | 175,726 | 15,543,394 | 165,123 |
| Progression bots earning XP | 52 | 52 | 52 | 52 |
| Progression-bot earned XP | 89,944.8 | 73,753.8 | 83,363.6 | 87,573.8 |
| All-bot earned XP | 313,425.5 | 277,012.9 | 219,719.3 | 246,687.7 |
| Level gains through addXp | 638 | 554 | 625 | 641 |
| Verified save round trips | 100 | 100 | 100 | 100 |

| Processing time | Seed 254 before | Seed 254 after | Seed 255 before | Seed 255 after |
| --- | ---: | ---: | ---: | ---: |
| World mean / p95 / max, excluding first 20 ticks (ms) | 15.94 / 23.59 / 241.03 | 17.32 / 24.30 / 331.59 | 17.86 / 27.18 / 456.53 | 18.33 / 26.08 / 261.51 |
| Bot mean / p95, excluding first 20 ticks (ms) | 4.80 / 10.10 | 6.61 / 12.51 | 5.58 / 11.88 | 6.79 / 12.78 |
| Startup-inclusive world max (ms) | 3788.23 | 4117.44 | 4136.98 | 3623.39 |
| Startup-inclusive / steady ticks over 600ms | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |
| Wall time including final save checks (seconds) | 106.73 | 115.53 | 119.00 | 120.87 |

Stationary false positives were eliminated in both runs. The old six-tick oscillation reset also prevented its ten-tick stationary-walking detector from firing; the new nonzero walking-stuck counts expose those genuine attempts. The updated runs still recorded movement cycles, unreachable targets and path failures. Their raw counts remain in the JSON report and periodic summaries.

Performance and progression are mixed: steady-state processing cost increased, while remaining below the 600ms budget in every measured steady tick. Seed 254 progression-bot XP decreased from 89,944.8 to 73,753.8 (18.0%), while seed 255 increased from 83,363.6 to 87,573.8 (5.1%). Combined progression-bot XP was 6.9% lower across the two seeds. These changes improve detection and bounded recovery; these runs do **not** establish a general XP-throughput improvement. No reward or personality adjustment was made to compensate for the measured difference.

Interpretation limits: seeded randomness gives the same starting workload, but changed recovery decisions and existing wall-clock task timers produce different trajectories. Two seeds cannot establish an XP-throughput improvement for every skill. Vendors and social bots need not gain XP to be functioning. Remaining genuine recoveries are counted and logged; zero stationary oscillations is not a claim that every route is now reachable. Early startup/JIT outliers and steady-state processing are reported separately. Accelerated ticks do not validate real-time timer behavior, VM scheduling, browser latency, or a multi-day soak.

## Regression checks

Run from the assembled updated runtime:

```sh
npm run test:bot
npm run test:integrity
```

The bot suite covers stationary activities, real period-2/3 cycles, pauses/floor changes, subtask early returns, stuck recovery, destination retry budgets, long detours, cache bounds, log filtering/rate limits, timing metrics, native rsmod turn order, CSV blockers between turns, enclosed sources, inactive NPCs, sheep rotation/depletion/regrowth/partial batches, planner cooldowns, personality weights and combat approach expiry. The bot suite passes 19 tests, including both real-map fixtures; the integrity suite passes five tests including its parent case. Runtime tests isolate SQLite in a temporary directory. The integrity suite compiles r254 with all three verification switches enabled and deliberately changes `.npc`, `.obj` and `.if` content to confirm checksum rejection.

The assembled baseline and updated engines also receive `tsc --noEmit`. Both retain the same pre-existing errors in the applet/camera/mouse event message types and ReportAbuse imports/enum; there are no new errors in the changed production code. These unrelated protocol typing errors are outside this PR.
