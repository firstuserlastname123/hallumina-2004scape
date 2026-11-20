# Reachability and native navigation on r254

The [PR #6 navigation follow-up](playerbot-navigation-followup.md) contains the current corrections, 43-test validation and six new 6,000-tick comparisons. The initial implementation and measurements below are retained as the `dd8e4abd` snapshot.

This change starts from merged `dev` at `f9424aeeec2004a7d779f1a65ca5461136a73d9b` (PR #5). It keeps the 100 configured characters and their personality weights. PKer, vendor and social task implementations, native content, collision data, XP formulas, tutorial enrollment, save formats and SQLite schemas are unchanged.

## Investigation

PR #5's final two 2,000-tick runs recorded 197 combat approach timeouts, 30 oscillations, 111 path failures and 10 no-progress events. Its fresh native tutorial flow removed the earlier island stalls but exposed more mainland movement. These historical counts are context, not the baseline for this PR's longer paired comparison.

The shared engine already provides directional collision, legal entity/loc operating-distance checks, compressed paths, a gateway catalog and native ship/tunnel journeys. Bot collision CSVs add rejections; they cannot override engine collision. Native obstacle clicks already wait for observable passage and suppress failures. The remaining problems were in how callers selected and executed those routes:

- `canBotTravel` accepted any nonempty move-near result, including a path ending short of an enclosed destination. Local resource and bank selection mostly ranked coordinates rather than usable approaches.
- Mining chose a fresh nearest rock on each approach tick and walked toward its occupied tile. Woodcutting could choose an enclosed tree before discovering a different tree was reachable. Fishing used a distance threshold that did not establish a legal operating face.
- Ground-spawn collection reselected the nearest spawn every walking tick, undoing its alternate-spawn choice, and revisited an already-passed via point. The held target, consumed via and bounded unavailable-spawn cooldown now survive successive ticks.
- Melee selected a verified attack route, then discarded it when sending Attack. With native client routefinding enabled, the engine falls back to a naive NPC chase. This can stall at an edge even though the selector found a valid route around it.
- The walking fallback accepted the first nonempty compass result, without comparing walked cost or its actual endpoint. Random escape walks in gathering and banking could replace a useful route. A legal local route could also be diverted through an unnecessary gateway chain.
- Directional gate filtering and candidate radius checks used a loc's origin. The five-tile Gnome gate can be directly ahead while its origin is outside that narrow corridor/radius. Its first native click may complete Femi's dialogue instead of opening the gate; suppressing that now-unlocked gate immediately exhausts short local retries.
- A real-map reproduction at (3212,3237) alternated between z=3237 and z=3238 on a journey to the west Varrock mine. The Lumbridge bypass grouped disconnected mainland regions together. Gateway legs were also considered finished within five tiles, before an actual crossing. Routing these overlapping eastern-mainland hints from collision and finishing selected gateway legs removes that reversal.
- Native player movement passes the `PLAYER` collision flag, while bot path validation passed zero. At (3103,3348), the proposed south step passed the old check and failed the engine's player check. A bounded local A* fallback now tests exactly those live step rules without modifying global collision.
- An obstacle's 25-tick timeout included its approach. Native waypoint queues retain the tail when over capacity; a long approach could lose its first turns and walk directly into collision. The new long-door fixture exercises a 29-turn path.
- Shared banking could choose a booth across a blocked edge, change banks during a trip, or return its direct-deposit fallback with no usable service. ShopTrip assumed a shop opened after three task calls and directly exchanged estimated coins for items even when a native trade had not finished.

Existing runtime regressions also exercise locked Varrock doors, the Lumbridge chicken gate, native stairs and ladders, both Gnome course floors, the Fishing Contest tunnel, toll avoidance, customs restrictions, membership, fare reserves and long mainland journeys.

## Implementation

`BotNavigation` now distinguishes exact tile reachability from useful partial movement. New shared selectors compare up to 24 nearby candidates using collision-validated paths to native operating faces and the number of walking tiles, rather than the number of compressed turns. Melee retains its existing twelve-candidate bound and safety/claim checks. If a native route runs through a live player-blocking tile or a supplementary blocker, a local A* fallback can find another legal route. It is limited to destinations within 60 tiles, a 64-tile search radius and 4,096 expansions. Every step uses the same `PLAYER` collision flag as normal player movement, including diagonal restrictions; no map flags are temporarily changed. Resource candidates must still be live and match their existing skill requirements. Woodcutting adds a sharing penalty while retaining a reachable claimed tree as a possible choice.

Mining holds its live selected rock and approaches a legal face. Fishing holds its live spot, checks a legal face, and preserves a successful ongoing native fishing interaction. Depleted or disconnected targets trigger another reachable local choice. Floor-item pickup likewise holds its selected spawn, consumes its via point once, and temporarily excludes depleted or unreachable spawns. A real inventory receipt completes that task before eligibility checks can misclassify success as a failure. Melee queues its verified approach with Attack and repairs a lost route only between attempts. Actual travel toward the acquired position can extend its approach inactivity budget; NPC movement and a new route request cannot. Adjacent native fights retain their existing interactions and damage-drought ceiling.

Walking first accepts a verified local route when available. Otherwise it compares safe segments by walking cost plus estimated remaining distance. Partial routes must actually advance before being accepted as a direct approach. Inaccessible destinations within ten tiles yield to bounded recovery rather than starting an arbitrary compass escape. A bounded, expiring segment memory penalizes immediate backtracking; it never grants progress or replenishes retries. Known gateways still provide necessary detours and floor crossings. The overlapping Lumbridge, River Lum and Draynor fence hints use live collision routes. Other verified terrain corridors, physical entrances and the northern Al Kharid bypass remain in the catalog. A held gateway leg finishes at its actual selected tile before the bot reclassifies regions. Adjusted walkable endpoints update that held leg too.

Obstacle selection considers the loc footprint and reachable operating cost. Pending operations preserve native scripts through their delayed phases. Observed movement extends the 25-tick idle allowance, with a 200-tick overall ceiling. Long approaches queue the executable prefix and continue from the real position. Femi's native prerequisite result permits a fresh gate click; no quest value is assigned by navigation. Failed doors retain their existing suppression and can later be retried.

Bank trips hold a task-owned destination. Local bank stands use exact path costs; remote choices estimate land, fare and transport costs using the existing native travel eligibility checks. Repeated failed routes or missing local services can select another bank without resetting the task's retry budget. Booths and bankers require a reachable operating face. The direct-service fallback no longer reports readiness.

ShopTrip selects a reachable shopkeeper, retains its approach, waits for the real shop interface and buys through the native stock listener. The native script controls stock, price and capacity. Missing services, stock and refused purchases defer instead of fabricating a purchase. Supported batch buttons preserve the requested quantity.

## Architectural references and licensing

[2004bot.com](https://2004bot.com/) presents the [rs2b0t project](https://github.com/rs2b2t/rs2b0t); these are two names for the referenced client project. Its [movement API](https://2004bot.com/docs/api/movement/) and [pathfinding design](https://github.com/rs2b2t/rs2b0t/blob/main/docs/reference/nav-pathfinding.md) provided useful examples of explicit reachability outcomes, costed routes, door/transport edges and replanning when the world changes. Its [walker design](https://github.com/rs2b2t/rs2b0t/blob/main/docs/reference/nav-walker.md) emphasizes confirming an action's result before continuing.

The repository's [MIT license](https://github.com/rs2b2t/rs2b0t/blob/main/LICENSE) was reviewed. This PR independently implements those architectural ideas against the existing server APIs. It copies no client implementation, scripts, collision packs or transport catalog. In particular, it does not port a later revision's route coordinates or adopt a client bot runtime.

## Validation and measured results

All **42** regression tests pass, covering native melee, navigation, content checksum rejection, human and bot persistence/restarts, and fresh/legacy tutorial lifecycle behavior. The new native fixture additionally checks enclosed targets and dynamic reopening, resource alternatives, legal mining faces, retained melee routes, a long door approach, unavailable bank stands, native shop stock, the Lumbridge boundary journey, and player-blocking collision. A deterministic unit check bounds local-detour work. `tsc --noEmit` reports the same 11 existing client protocol errors and no errors in the changed bot code.

The four final runs used seed 254 or 255, 100 configured bots, 6,000 complete world ticks (60 simulated minutes), 1× XP, verified r254 packs, production mode and an empty disposable SQLite/save profile. All runs were sequential, with no concurrent test workload. The same observer and native script/config hashes were used in both versions. [Machine-readable results and source manifests](playerbot-intelligent-navigation-results.json) retain counters, timing distributions, cohorts, per-bot native XP, task completions and sampled failure locations.

| Observation | Dev 254 | PR 254 | Dev 255 | PR 255 |
| --- | ---: | ---: | ---: | ---: |
| Navigation oscillations | 20 | 0 | 15 | 0 |
| Stationary-only oscillations | 0 | 0 | 0 | 0 |
| Walking-stuck recoveries | 355 | 204 | 427 | 218 |
| Path failures | 106 | 442 | 423 | 351 |
| No-progress events | 16 | 16 | 14 | 14 |
| Combat approach timeouts | 218 | 37 | 253 | 30 |
| Native hero-credited melee kills | 583 | 813 | 620 | 545 |
| Native melee XP | 10,456 | 13,736 | 10,876 | 10,100 |
| Task-awarded melee XP | 0 | 0 | 0 | 0 |
| Verified gate openings | 144 | 80 | 139 | 75 |
| Unverified gate script outcomes | 12 | 4 | 13 | 6 |
| Verified transition completions | 78 | 0 | 26 | 1 |
| Native bank interface openings | 849 | 982 | 874 | 941 |
| Native shop interface openings | 41 | 156 | 49 | 155 |
| Main task completions | 865 | 1,004 | 932 | 879 |
| Main task deferrals | 534 | 670 | 578 | 551 |
| Child task deferrals | 0 | 0 | 0 | 0 |
| Progression-bot native XP | 46,918.6 | 49,517.1 | 43,059.0 | 44,492.5 |
| Progression bots earning native XP / 52 | 52 | 52 | 51 | 52 |

| World processing | Dev 254 | PR 254 | Dev 255 | PR 255 |
| --- | ---: | ---: | ---: | ---: |
| Steady mean / p95 / max (ms) | 17.40 / 23.75 / 240.89 | 18.54 / 33.13 / 211.37 | 16.23 / 22.12 / 240.74 | 20.33 / 34.26 / 236.74 |
| Startup-inclusive mean / p95 / max (ms) | 17.96 / 23.78 / 2971.12 | 19.10 / 33.30 / 2861.53 | 16.77 / 22.18 / 2819.73 | 20.88 / 34.33 / 2828.00 |
| Steady ticks over 600 ms | 0 | 0 | 0 | 0 |
| Startup-inclusive ticks over 600 ms | 1 | 1 | 1 | 1 |

Across the pair, oscillations fell from **35 to 0**, walking-stuck recoveries from **782 to 422** (-46.0%), and melee approach timeouts from **471 to 67** (-85.8%). Native hero-credited melee kills rose from 1,203 to 1,358, and progression-bot native XP rose from **89,977.6 to 94,009.6** (+4.5%). Main task completions rose from 1,797 to 1,883.

The comparison is mixed: path failures rose from **529 to 793**, no-progress events were unchanged at 30, and main task deferrals from **1,112 to 1,221**. The two seeds disagree on the path-failure direction. More routes are refused before repeated blocked walking, but these observations do not isolate early rejection from changed task choices. Steady world mean and p95 processing time increased on both seeds; no steady tick exceeded the native 600 ms budget. Observed gate-opening success among script attempts rose from 283/308 (91.9%) to 155/165 (93.9%), with fewer attempts. Population transition counts fell sharply, so the successful focused stair/ladder probes should not be read as broad transition coverage.

Every run ended with 100 active bots, 100 accounts, 100 verified save CRC/stat/coordinate/permanent-inventory round trips (including banks), SQLite `quick_check=ok`, and zero logged errors. Original workspace userdata and the existing runtime database/save tree retained their pre-validation content hashes. Save/inventory implementations and schemas were not changed.

Counts are observations, not rates normalized for identical task choices. Completed tasks include support activities and do not count every gather action or kill. Shop completions now require a real native purchase. Verified obstacle counters require observed world changes; script attempts and unverified outcomes are retained separately in the JSON. Native XP excludes preset profile stats and task-granted awards. Steady timings exclude the first 20 ticks; startup-inclusive timings retain those ticks.

To reproduce, assemble each checkout separately as described in [the simulation setup](playerbot-reliability.md#reproduce-the-simulations), use the submitted `tools/bot/simulate.ts` observer in both, and run sequentially with:

```sh
NODE_PROFILE=bot-simulation DB_BACKEND=sqlite NODE_PRODUCTION=true \
ENGINE_REVISION=254 NODE_XPRATE=1 NODE_PROGRESSIVE_XP=false \
BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true \
BOT_DEBUG_ENABLED=false BOT_LOG_LEVEL=info BOT_LOG_RATE_TICKS=100 \
BOT_LOG_SUMMARY_TICKS=100 BOT_SIM_SEED=254 BOT_SIM_TICKS=6000 \
BOT_SIM_INTERVAL_MS=0 BOT_SIM_OUTPUT=/absolute/path/results.json \
node --import tsx tools/bot/simulate.ts
```

Repeat with seed 255 and a fresh disposable database/save profile for each run. For the full regression suite:

```sh
node --import tsx --test --test-concurrency=1 \
  tests/bot-reliability.test.ts tests/bot-runtime.test.ts tests/bot-melee.test.ts \
  tests/persistence-runtime.test.ts tests/build-integrity.test.ts
```


## Limits

Local reachability is exact within the native search and the supplementary CSV. Long-distance segment and remote-bank costs remain estimates; this is not an exhaustive world transport graph. A candidate beyond the bounded local shortlist can still be missed. Local detours can exhaust their search budget; they do not promise a route through arbitrary actor congestion or a closed barrier. Moving NPCs and changing collision can invalidate a route after selection. Unsupported crossings, quest restrictions, unaffordable fares, missing stock and exhausted routes still defer through native requirements.

The initial runs exposed repeated refusals around Draynor Manor (3109,3354), the Lumbridge castle interior (3215,3218), and several upstairs or underground positions. The [follow-up](playerbot-navigation-followup.md) corrects the empty-route fallback and adds verified native building/crypt routes and local door planning. Other unregistered exits still defer; no recovery teleport, quest override or fabricated progress conceals them. Both reports retain task/destination observations.

The tests use isolated characters and databases. Accelerated population runs exercise full world ticks but retain existing wall-clock bot timers; a fixed RNG seed does not imply identical decisions across code changes or host schedules. They do not establish unattended multi-day behavior or human client latency. No legacy Tutorial Island character is migrated, and native scripted crossings are not recovery teleports.
