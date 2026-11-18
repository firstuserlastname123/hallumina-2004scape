# Phase 1.1: environmental navigation on Progressive r254

Base: `dev` at `6f660f8` (PRs #2 and #3 merged). The engine revision, content scripts, collision data, personalities, rewards and persistence protocol are unchanged.

## Reproduced causes and corrections

| Reproduction using the bundled r254 map | Cause | Correction |
| --- | --- | --- |
| SocialTask requests `(3253,3415,0)` | This is the East Bank's plant/wall footprint, not its outdoor road. `(3259,3417,0)` is blocked too; `(3257,3419,0)` is inside. | Move the scan/spawn tile to `(3253,3412,0)` and replace the two unsuitable wander points with reachable outdoor tiles. Check all seven East Bank points against native collision, CSV rejection and exact routes. |
| Bot at `(3214,3261,0)` tries the sheep gate at `(3213,3261,0)` | The geometric adjacency helper says true while `Player.inOperableDistance` says false. The old helper directly dispatches OPLOC1 anyway. Its comment incorrectly claims the native scenery interaction path cannot work. | Use native operating-range rules, including shape, rotation and forceapproach. Queue one normal `setInteraction(ENGINE, ..., APLOCn)` click with a validated operating-position route. No direct gate script dispatch. |
| Repeated requests against `loc_1591` at `(3273,3417,0)` | A successful helper return meant a script was called, even though the game says the door is locked and leaves it closed. The helper repeats it indefinitely. | Observe the original loc and the passage collision; a click is not success. An unresolved attempt expires after 25 world ticks, consumes the existing task retry budget and suppresses that obstacle for 200 ticks. Suppression is bounded to 64 entries per player and expires; ordinary game scripts enforce locks and requirements. |
| Reissue walking while the Gnome bank staircase click is pending | Only Open operations were protected from `clearPendingAction`; the climb was replaced before the engine could process it. | Retain task-owned pending stairs/ladder gateway interactions until the expected floor/underground transition occurs or the attempt times out. Select the actual operation slot. Unknown floor routes fail through existing backoff rather than walking on the wrong floor. |
| Approach the oak at `(3161,3416,0)` from the east | Woodcutting assumes 2×2 trees; this oak is 3×3. Its chosen tile lies inside the tree. Some other nearest faces are blocked by adjacent map objects or CSV exclusions. | Reuse native `findPathToLoc`/`reachedLoc`, the runtime loc dimensions and step validation. Try other legal faces if the native endpoint is rejected. Temporarily exclude unreachable trees and try another resource, honoring the task retry/backoff budget. |
| Reset Gnome agility on floor 1 with the obstacle index at the ground-floor log | The task searches another floor for the log, then requests walking with the default level 0. | Resume the actual floor-1 branch or floor-2 rope/descending branch. Approach each obstacle on its own floor. Missing obstacles and timeouts consume bounded retries. Remove course-entry, lap and stuck teleports from AgilityTask. |
| Al Kharid approach from `(3267,3227,0)` | The gateway teleports across the toll gate. Its legitimate northern alternative also exposes partial-route replanning and a progress check measured only against the final destination. A detour can be sent back through already passed regions or exhaust the stall budget while travelling toward a necessary gateway. | Use the existing northern opening. Retain the selected gateway approach across partial paths and credit actual travel toward that stable intermediate tile for the stall deadline. Selecting a new intermediate tile never clears failures or extends the deadline. Ordinary wandering retains the original stall checks. The regression completes the entire route to `(3294,3172,0)`. |
| Activity watchdog reaches its deadline with an inaccessible destination | `ProgressWatchdog` grants a teleport to the activity destination or spawn. | Defer the task through the existing planner cooldown. Social tour/stuck and woodcutting stuck recovery also defer instead of teleporting. Unsupported toll/pass/boat gateway transitions defer; they do not cross the restriction. |

The existing native interaction and gate-recovery debugger hooks are retained. Pending obstacle state belongs to the current task. Interrupting or replacing the owner cancels its outstanding click. Gate verification requires a changed/removed closed loc and an open collision edge or an observed crossing. Floor verification checks the expected level and surface/underground side. Neither a fixed delay nor a helper returning true authorizes walking through a closed barrier.

The existing four-failure budget, exponential backoff, 200-tick planner deferral and parent/subtask isolation remain in use. The gateway progress addition extends only the stall deadline for observed travel toward a stable, explicitly planned gateway; the failure count remains intact. A dedicated regression also proves that stationary gateway retargeting cannot keep the deadline alive.

## Validation

The environmental fixture uses the assembled r254 engine and its original map/config/script packs. It does not allocate synthetic collision regions. Before correction, eight defect checks fail on `6f660f8`; native ladder operation, a normal Gnome lap and unsupported-floor rejection already work and remain covered. The final fixture checks eleven scenarios, including a complete script-driven Gnome lap through floors 0/1/2 and the complete northern Al Kharid route. Course XP comes from the normal game scripts.

Run from a disposable assembled runtime (the existing launcher builds `progressive-254`):

```sh
node --import tsx --test tests/bot-reliability.test.ts tests/bot-runtime.test.ts \
  tests/persistence-runtime.test.ts tests/build-integrity.test.ts
```

All **31 tests pass**: 18 playerbot reliability cases, three native-engine fixtures, five persistence cases and five integrity cases (including the parent). The environmental fixture reports eleven passing scenarios. Persistence coverage includes human/configured-bot shutdown and restart, local/central admission, save ownership, stale acknowledgements and logout retry fencing. Integrity coverage compiles r254 with all three verification switches and rejects modified `.npc`, `.obj` and `.if` content.

TypeScript comparison: `11 pre-existing protocol diagnostics in both base and corrected engines; normalized diagnostics are identical, with no new errors in changed code.`

## Comparable 100-bot simulations

[Machine-readable results](playerbot-environment-simulation-results.json) contain the four final runs, per-bot progression, 1,000-tick samples, task completion counts, obstacle observations, save/integrity checks and SHA-256 fingerprints of the production files. Earlier exploratory runs are excluded.

Each implementation runs seeds 254 and 255 with the same final observation harness, 100 configured bots, 6,000 complete world ticks, a fresh empty SQLite database and a fresh `bot-simulation` save profile. All four runs are sequential, with no concurrent test/build workload. The baseline is the assembled `6f660f8` engine; the corrected runtime overlays only the submitted engine source. Both use the same original r254 content/packs and installed dependencies (Node 24.22.1).

The existing harness safety checks reject a database containing humans, existing simulation saves, a missing disposable-runtime marker, a revision other than 254 or a population other than 100. No user saves/database are used. At the end of each run, all 100 bots exit through normal logout persistence; CRCs, stats, coordinates and permanent inventories are reloaded and compared, and SQLite `quick_check` runs.

Use the existing assembly/setup instructions in [playerbot-reliability.md](playerbot-reliability.md). Copy this version's `engine/tools/bot/simulate.ts` into both disposable engines and run each with:

```sh
touch .bot-simulation-runtime
NODE_PROFILE=bot-simulation DB_BACKEND=sqlite NODE_PRODUCTION=true \
ENGINE_REVISION=254 NODE_XPRATE=1 NODE_PROGRESSIVE_XP=false \
BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true \
BOT_DEBUG_ENABLED=false BOT_LOG_LEVEL=info BOT_LOG_RATE_TICKS=100 \
BOT_LOG_SUMMARY_TICKS=100 BOT_SIM_SEED=254 BOT_SIM_TICKS=6000 \
BOT_SIM_INTERVAL_MS=0 BOT_SIM_LABEL=before-or-after \
BOT_SIM_OUTPUT=/absolute/path/results.json \
node --import tsx tools/bot/simulate.ts > /absolute/path/gameplay.log \
2> /absolute/path/progress.log
```

Repeat with seed 255 in another fresh runtime. The harness fingerprints files itself; a filename absent in the baseline is recorded as null.

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Active bots / verified saves | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 |
| Native gate clicks | 0 | 961 | 0 | 921 |
| Gate script calls | 577 | 465 | 477 | 471 |
| Observed gate openings | 402 | 425 | 368 | 427 |
| Unverified gate-script outcomes | 175 | 40 | 109 | 44 |
| Production obstacle timeouts | n/a | 351 | n/a | 304 |
| Transition scripts / observed completions | 1,932 / 1,752 | 0 / 0 | 2,307 / 2,084 | 0 / 0 |
| Raw path failures | 431 | 308 | 389 | 472 |
| No-progress failures | 24 | 8 | 14 | 16 |
| Oscillation recoveries | 114 | 32 | 98 | 25 |
| Walking-stuck recoveries | 655 | 683 | 567 | 691 |
| Task deferrals | 199 | 655 | 174 | 716 |
| Raw timeout diagnostics | 1,180 | 475 | 1,148 | 392 |
| Raw resource-unavailable events | 100 | 240 | 44 | 112 |
| Queued routes / active route clears | 39,450 / 17,175 | 23,543 / 10,061 | 38,911 / 16,730 | 23,277 / 10,067 |
| Emitted console lines / bytes | 1,399 / 191,115 | 1,606 / 212,478 | 1,262 / 176,356 | 1,629 / 212,926 |
| Progression bots earning XP | 52 / 52 | 52 / 52 | 52 / 52 | 52 / 52 |
| Progression-bot earned XP | 76,718.8 | 41,615.5 | 85,707.0 | 39,119.2 |
| All-bot action XP / level gains | 252,037.6 / 586 | 210,988.4 / 300 | 248,851.8 / 636 | 162,481.0 / 270 |

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Recorded Agility completions | 2 | 0 | 3 | 0 |
| Recorded Bank completions | 5 | 7 | 6 | 4 |
| Recorded Idle completions | 86 | 810 | 99 | 1,074 |
| Recorded Init completions | 52 | 52 | 52 | 52 |
| Recorded ShopTrip completions | 185 | 271 | 142 | 273 |

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Steady world mean / p95 / max (ms) | 15.58 / 21.80 / 268.41 | 13.30 / 19.91 / 272.85 | 15.45 / 21.99 / 280.95 | 12.11 / 17.71 / 319.30 |
| Steady bot mean / p95 / max (ms) | 5.83 / 11.08 / 59.22 | 2.71 / 7.07 / 34.04 | 5.73 / 10.90 / 56.18 | 2.77 / 7.13 / 42.05 |
| Startup-inclusive world max (ms) | 3481.24 | 3469.74 | 3373.52 | 3314.81 |
| World ticks >600ms: startup / steady | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |
| Wall seconds including save checks | 104.20 | 90.53 | 103.31 | 83.28 |

Across seeds, raw path failures are 780 versus 820 (-4.9%). Seed 254 improves from 431 to 308; seed 255 worsens from 389 to 472. Oscillation recoveries fall from 212 to 57, while walking-stuck recoveries rise from 1,222 to 1,374. Both implementations retain zero stationary-only oscillation false positives.

Independently observed unverified gate-script outcomes fall from 284 to 84. Native clicks and script calls are separate denominators: some accepted clicks never dispatch a script, and another actor may open a pending gate. The new production obstacle-timeout counters expose unsuccessful queued attempts too; they have no baseline equivalent.

Task deferrals rise from 373 to 1,371. Recorded Idle completions rise from 185 to 1,884; this is not evidence of increased productive task throughput. The task table retains the actual completion categories. All 52 progression bots earn XP in every run, but combined progression-bot XP falls from 162,425.8 to 80,734.7 (-50.3%). Removing travel/recovery shortcuts and honoring restrictions changes task participation; no reward, item, XP multiplier or teleport is added to offset the reduction.

The corrected population runs dispatch **zero floor/agility transition scripts** and complete zero Agility tasks, versus 4,239 transition-script calls and 5 Agility task completions in the baseline. They do not establish improved population course access. Native stairs, ladder operation, pending-climb preservation, Gnome floor recovery and a complete Gnome lap are validated by the dedicated fixture. The existing gateway graph routes broad Kandarin/Fremennik regions through boat gateways. Deferring those unsupported crossings also prevents some inland course trips; the 300-active-tick activity deadline can defer long legitimate walks before arrival. More complete legitimate land/course routing remains a limitation.

All four runs retain 100 active bots, pass all 400 save round trips, retain 100 database accounts each and return SQLite `ok`. No steady world tick exceeds 600ms. This comparison combines the navigation corrections with removal of recovery/travel shortcuts and cannot isolate each change's effect. Lower mean processing times occur with a changed task mix and substantially more idle/deferral behavior; they do not establish an algorithmic speedup. Warning volume and failed resource searches can increase; the raw values remain in the tables and JSON.

### Measurement definitions

- Gate clicks count accepted native interactions; gate script calls also capture the baseline's direct execution. A gate opening is independently observed as the original closed loc changing/disappearing and its old edge becoming passable. Script-outcome observations start at an OPLOC script execution call; clicks that never dispatch remain visible in native click and production timeout totals. Unverified observations include refused/locked operations and attempts still unresolved at the end; an observed opening need not mean that a whole task completed.
- Transition observations cover scripted stairs/ladders/agility operations. A completed observation requires the script/interaction to settle and a floor change or displacement of at least two tiles. These population displacement counts are diagnostic evidence, not a claim that every agility obstacle succeeded. The dedicated complete-lap fixture verifies the Gnome course itself.
- Task completions instrument the existing `_recordComplete` call. Long-lived tasks such as Social do not normally complete. Deferrals and raw path/no-progress failures are separate from completions; emitted warning volume is separate from raw event counts.
- World timing measures the world cycle, and bot timing measures `BotManager.tick`. Observation overhead after the world cycle is excluded from both implementations' world samples. First-20-tick startup samples and steady samples are reported separately. Queued blocked first steps include native interaction routes and do not mean collision was bypassed; actual movement still uses engine collision.

## Remaining limitations and review status

This PR is submitted as a draft because the measured 50.3% progression-XP reduction, increased idle/deferral behavior and absent population course participation need review before merging. Passing targeted regressions and persistence checks does not resolve those population tradeoffs.

This is a local gateway graph, not a general multi-floor or world transport planner. Unsupported floor routes, boat dialogs, passes and requirements can still defer tasks; no toll or quest bypass is added. Gnome course behavior is exercised through a full lap; Barbarian/Wilderness course behavior has not received comparable full-course validation. Gate selection remains a local directional heuristic, so barriers beyond its search radius and complex multi-obstacle routes can still fail.

The simulations include pre-existing initial social placement and task-specific travel policies elsewhere in the bot code. Those policies merit a separate progression audit; this change removes the reproduced gateway/watchdog and touched-task recovery shortcuts without changing unrelated task rewards, inventory grants, personality configuration or persistence.

These are accelerated managed-host runs: 6,000 ticks represent one hour of game time, while the production 600ms tick constant is unchanged. Seeded starts do not produce identical later trajectories because task decisions consume different random numbers and some existing tasks use wall-clock timers. Two seeds cannot establish universal throughput improvement. Paced Ubuntu/VirtualBox scheduling, browser/network load and a long-duration soak remain unmeasured.
