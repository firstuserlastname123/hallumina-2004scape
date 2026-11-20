# Navigation follow-up for PR #6

This follow-up compares merged `dev` (`f9424aee`), the initial PR commit (`dd8e4abd`), and the corrected navigation implementation. Population allocation, specialist task implementations, gameplay/content, XP rates, tutorial enrollment, inventories, save formats and SQLite schemas are unchanged. The melee approach, reachable resource selection and native shop improvements from PR #6 are retained.

## What the original regressions mean

The earlier aggregate comparison was 104 → 1 “transition completions,” 529 → 793 path failures, and 1,112 → 1,221 deferrals. These were real observations, but the transition counter was not a count of successful stairs alone. It also includes ship gangplanks and same-floor agility crossings, and its legacy option matcher does not recognize `Walk-up` / `Walk-down`. It cannot establish a stair success rate without counting opportunities and identifying the content involved.

The common observer now records task/state exposure, native transition clicks/scripts/outcomes by object and task, actual plane/underground changes, uncapped aggregated failure locations, and deferral reasons. These observations do not change decisions or consume random numbers. The legacy counters retain their previous definitions so the comparison remains interpretable. Actual floor-change observations also include native random events and travel boarding; they must not all be attributed to bot-planned stairs.

In the new reruns, prior PR transition completions are 0 and 9, against dev's 82 and 54. Dev's 136 comprise **69 ship gangplanks and 67 Gnome-course crossings**; the prior PR's 9 comprise **4 gangplanks and 5 Gnome-course crossings**. The corresponding script-attempt counts are 137 and 9. There is no evidence here of a native stair script repeatedly failing after activation: almost all the missing outcomes disappeared before a click. Agility starts remain substantial (dev 290, prior PR 304), but its state and location exposure differ. Affordable, fixed-inventory journeys to the Gnome course succeed on both versions, and the existing native full-lap regression passes.

That does **not** make the increased refusals harmless. Prior PR reports 196 path failures at the Manor entrance and 81 in the Lumbridge hall across these reruns; dev reports zero `path_failed` events at those exact origins. Fixed journeys reveal that both versions already fail to leave those locations: dev often queues partial movement or stalls instead of reporting an immediate path refusal. Missing upstairs/underground exit links also predate PR #6. Thus changed activity/exposure and earlier failure classification explain part of the aggregate increase, while genuine navigation gaps remain.

There is also a specific correctness bug introduced by the new reachability helpers: an empty native route, or a route whose first step the CSV rejects, returns before the bounded A* fallback. A legal alternative can exist. This affects tile routes, NPC operating faces and, indirectly, loc approaches. Two regressions now explicitly force an empty CSV-trimmed prefix and require a valid alternative; enclosed destinations must still remain unreachable.

## Corrections

- `findTileRoute` and `findNpcApproach` run the existing bounded fallback after empty initial routes as well as invalid nonempty routes. Existing exact-arrival, live-entity, floor and blocked-destination checks remain in force.
- A bounded local door plan can identify a necessary door beside or behind the player, including a chain of interior doors. Its abstract door edges are used only to select the first native click. They are never queued as walking steps and never applied to global collision. The approach still requires a real native operating face. After passage the bot replans from its actual position; native locked/quest interactions and failed-obstacle suppression remain authoritative.
- Verified r254 local links cover Lumbridge Castle stairs and hall exit, Manor stairs/back door/crypt, Morgan's Draynor stairs, Al Kharid upper ladders, and Wizards Tower cellar access. Coordinates identify native locs and estimate onward route costs; they never relocate a player. Native option slots are preserved, including `Walk-up` / `Walk-down` and third-slot `Climb-down`.
- Manor front doors admit entry but refuse exit. Navigation uses the back door, recognizes its reachable outside stand, and avoids routing an outside journey back through the one-way front entrance. This prevents repeated reentry after successful passage.
- Existing pending interactions and queued movement retain priority. No recovery teleport, artificial XP, quest bypass or fabricated inventory/progression is added.

The local door plan retains the same 60-tile goal distance, 64-tile search radius and 4,096-expansion limit as the local fallback; its shortlist is at most 24 nearby straight-wall doors. It is a bounded native-interaction plan, not a world-wide transport solver.

## Focused checks

All **43** top-level regression tests pass. The new fixture contains **12** native journeys: Castle hall → Draynor bank; Castle first/second-floor exits and stair entry; Manor ground/first-floor exits, crypt entry/exit; Draynor stairs; Al Kharid ladders; and Wizards Tower cellar entry/exit. Each requires exact arrival, the expected native loc scripts, preservation of an in-flight click, no pending recovery teleport, unchanged XP, and unchanged quest variables. Manor exits must never invoke its front-door scripts. Two additional checks cover the empty-prefix fallback. Existing native melee, resource alternatives, shop stock, locked barriers, Gnome laps, travel restrictions, human/bot restart integrity and tutorial lifecycle tests pass.

`tsc --noEmit` retains the same **11** existing client-protocol errors as dev, with normalized diagnostics matching the baseline and no new errors.

A separate matched diagnostic uses identical start/goal coordinates and inventories on all three versions, with a two-tile arrival tolerance and a 1,800-tick limit. Ten of its twelve previously failed entrance/exit journeys now reach their original goals; the control journey to the Gnome course succeeds on all versions. The other two journeys now complete their native stairs/ladder crossings, but still fail on their longer onward ground routes from Morgan’s house and Wizards Tower. It includes the longer journeys from the original failure locations, rather than shortening every goal to a nearby landing. Results and remaining failures are retained in the [machine-readable report](playerbot-navigation-followup-results.json). The committed fixture additionally verifies the successful shorter native crossing where a longer onward journey is still unsupported.

## Paired population results

Six fresh disposable profiles ran sequentially: dev, prior PR and corrected code, each with seeds **254** and **255**, **100 bots**, **6,000 full world ticks**, verified r254 packs and **1× native XP**. No native probes or test workload ran concurrently with these measured simulations. The same observer, bot configuration, native scripts and collision CSV were used in every version. Source manifests and raw-report digests are in the report. The 52 progression characters and 48 specialist characters are unchanged.

These are new runs, not revisions of the original 529/793 counts. Accelerated simulations retain existing wall-clock timers, so fixed seeds do not produce identical choices across code changes or runs. Use the matched native checks to establish correctness, and the population observations to assess activity and remaining exposure.

| Observation | Dev 254 | Prior PR 254 | Corrected 254 | Dev 255 | Prior PR 255 | Corrected 255 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Navigation oscillations | 17 | 0 | 0 | 31 | 0 | 0 |
| Walking-stuck recoveries | 383 | 198 | 224 | 318 | 274 | 248 |
| Path failures | 327 | 686 | 329 | 128 | 306 | 231 |
| No-progress events | 23 | 27 | 16 | 15 | 47 | 23 |
| Melee approach timeouts | 237 | 34 | 32 | 191 | 35 | 37 |
| Native melee kills | 570 | 612 | 793 | 569 | 697 | 662 |
| Verified gate openings | 153 | 83 | 109 | 139 | 82 | 104 |
| Legacy transition completions | 82 | 0 | 3 | 54 | 9 | 3 |
| Legacy-classified transitions changing floor | 70 | 0 | 3 | 47 | 7 | 3 |
| Observed plane/underground changes (all causes) | 183 | 66 | 52 | 145 | 73 | 62 |
| Native bank interfaces | 958 | 1,107 | 507 | 356 | 1,236 | 1,619 |
| Native shop interfaces | 33 | 154 | 166 | 33 | 151 | 176 |
| Main task completions | 951 | 1,122 | 1,063 | 794 | 930 | 944 |
| Main task deferrals | 568 | 721 | 642 | 507 | 638 | 617 |
| Progression-bot native XP | 42,101.9 | 50,487.2 | 55,630.8 | 41,992.6 | 53,978.2 | 53,876.9 |
| Progression bots earning XP / 52 | 51 | 52 | 52 | 51 | 52 | 52 |

| World processing (ms) | Dev 254 | Prior PR 254 | Corrected 254 | Dev 255 | Prior PR 255 | Corrected 255 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Steady mean / p95 / max | 20.11 / 28.18 / 243.54 | 22.52 / 40.27 / 252.53 | 23.02 / 40.68 / 251.18 | 19.51 / 27.33 / 279.63 | 24.55 / 41.22 / 275.71 | 25.83 / 45.72 / 280.82 |
| Startup-inclusive mean / p95 / max | 20.78 / 28.31 / 3512.63 | 23.18 / 40.59 / 3263.52 | 23.78 / 40.89 / 3676.83 | 20.14 / 27.45 / 3327.85 | 25.19 / 41.34 / 3299.32 | 26.54 / 45.76 / 3441.57 |
| Steady ticks over 600 ms | 0 | 0 | 0 | 0 | 0 | 0 |

Against the prior PR across both seeds, path failures fall **992 → 560 (-43.5%)**, deferrals **1,359 → 1,259 (-7.4%)**, and no-progress events **74 → 39**. Oscillations remain zero, melee approach timeouts remain **69** (dev: 428), and native melee kills rise **1,309 → 1,455**. Progression-bot native XP rises **104,465.4 → 109,507.7 (+4.8%)**; all 52 progression bots earn native XP on each corrected run. The repeated `path_failed` origins at the Manor entrance, Lumbridge hall and the tested Castle first-floor position disappear in both corrected seeds.

The comparison still has costs and limits. Task completions fall **2,052 → 2,007 (-2.2%)**, and failures/deferrals remain above dev's **455 / 1,075**. Steady mean and p95 increase slightly on seed 254 and more on seed 255; maximum steady processing is **280.82 ms**, with no steady tick over 600 ms. Bank-interface counts also change with activity exposure. The legacy transition count remains low, **9 → 6**: the corrected six are actual native stairs, whereas the prior nine are gangplanks/agility. There are no failed legacy-classified transition attempts in either corrected run. This is evidence for the focused native fixes, not restored broad population transition coverage; course/travel choices still differ and the local catalog remains incomplete.

All six runs retain 100 active characters, 100 accounts and 100 verified save round trips each, including stats, coordinates and permanent inventories/banks. SQLite `quick_check` returns `ok` and logged errors are zero. Original workspace userdata, live SQLite and existing save-tree content hashes remain unchanged. No persistence implementation was edited.

## Remaining limits and reproduction

The local catalog is deliberately incomplete. Some random-event destinations and unregistered upper floors, including Varrock palace level 3, still have no supported native route. Successful floor passage is not proof that every subsequent long-distance ground route can leave a building. Straight-wall door planning does not model every diagonal door, rectangular gate, quest transport or multi-level world connection. Dynamic collision and bounded search can still cause deferrals. The exact failure aggregates, task/state exposure and deferral reasons are retained for further investigation; no teleport or progression award masks them.

Use the [existing simulation setup](playerbot-reliability.md#reproduce-the-simulations) with separate assembled checkouts and fresh disposable SQLite/save profiles. Copy the submitted `tools/bot/simulate.ts` into each checkout, use the environment shown in the [initial navigation report](playerbot-intelligent-navigation.md#validation-and-measured-results), and repeat seeds 254 and 255 with `BOT_SIM_TICKS=6000`. The current source labels in this follow-up are `dev`, `head` and `fix`.

Run the deterministic suite from an assembled engine:

```sh
node --import tsx --test --test-concurrency=1 \
  tests/bot-reliability.test.ts tests/bot-runtime.test.ts tests/bot-melee.test.ts \
  tests/persistence-runtime.test.ts tests/build-integrity.test.ts
```

The new native fixture is `tests/fixtures/bot-native-exits.ts`; the empty-prefix checks are in `tests/fixtures/bot-intelligent-navigation.ts`.
