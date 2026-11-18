# Phase 1.1 continuation: land routes and native transportation

This continues PR #4 from `4577f61`. The [initial environmental investigation](playerbot-environment-navigation.md) and its measurements are retained as historical evidence. This report covers the subsequent land, transportation, access-policy and travel-progress corrections. Revision 254, personalities, content scripts, collision data and the character save format remain unchanged.

## Audit and reproduced defects

- The existing gateway graph described the Port Sarim and Brimhaven boats as entrances to broad mainland regions, including Kandarin and Fremennik. Unsupported crossings could therefore veto a legitimate land journey. Transport is now optional journey planning; these boat entries no longer participate as mandatory geographic boundaries. The Brimhaven fence applies to actual island travel, using the existing Karamja polygon rather than a rectangle that would also include Rimmington.
- Unlimited bot pathfinding can return more than the engine's 25-waypoint capacity. The engine's queue retains the tail of oversized inputs, discarding the first turns. The real Varrock-to-Gnome reproduction stopped at `(3067,3420,0)` and exhausted four failures after 214 ticks. Bots now queue the executable prefix and generate the next segment from the position they actually reach. Engine collision is retained.
- A real Falador-to-Catherby walk was still progressing at the old 300-tick activity deadline and was deferred at `(2844,3461,0)`. The watchdog now recognizes new, measured progress toward a stable destination or planned gateway. It does not credit queueing, selecting another target or stationary retargeting. The 300-tick inactivity limit and existing failure/backoff budgets remain. Periodic goal rescans wait through verified travel, including the gap between path segments.
- A bot standing on the closed Brimhaven gate's tile produced a zero directional vector, excluding the gate from a forward search. That valid current-tile case now qualifies for a normal interaction. Native collision and access checks still decide whether the gate can be operated.
- Rectangular, script-operated gates can move a character across their width rather than the edge assumed for a one-tile wall. Verification now recognizes that native crossing, while still requiring the original barrier to change. Existing doors, pending climbs, floor changes and task-owned obstacle recovery remain covered.
- Dialogue continuations and menu selections are different native messages. Registered menu buttons can also accumulate across previous interfaces. The bot observes the normal interface messages, limits its text cache, selects registered buttons belonging to the current chat interface and uses the existing `ResumePauseButtonHandler`/`IfButtonHandler`. Options are matched by allowed text, not a fixed numeric position.
- Startup was marking every quest complete on **every bot login**, including Fishing Contest, and overwriting Femi/Barcrawl/warning access flags. This bypassed requirements and overwrote saved progress. These overrides are removed. Fresh bots keep normal default quest/access state; loaded flags retain their saved values. The old manager fails the new fresh-character assertion with Fishing Contest `5` instead of `0`. The corrected restart test verifies both completed Fishing Contest and partial Grand Tree progress survive reload without being manufactured or overwritten.

## r254 transportation audit

The paths below refer to the assembled r254 content tree. No content scripts were changed.

| Method | Native implementation | Requirements and cost | Execution/arrival |
| --- | --- | --- | --- |
| Port Sarim → Musa Point | `areas/area_port_sarim/scripts/sailors.rs2`, `[opnpc1,_sailor]`; Captain Tobias is used | 30 carried coins. Dragon Slayer stages 2 through pre-completion introduce a three-option menu; the fare option remains “Yes please.” | Native NPC interaction, native menu/payment, `set_sail`, then native gangplank disembarkation. |
| Musa Point → Port Sarim | `areas/area_karamja/scripts/customs_officer.rs2` | 30 coins; ordinary search dialogue, with the Pirate's Treasure state changing the conversation. Rum is prohibited. The planner rejects this method while carrying rum rather than attempting to smuggle it. | Native customs conversation/search/acceptance; native fare deduction and sailing. |
| Ardougne → Brimhaven | `areas/area_ardougne_east/scripts/captain_barnaby.rs2`, reusing `karamja_sailor_dialogue` | Members' geography and 30 coins; same sailor menu variation | Native Captain Barnaby interaction and sailing; native gangplank at Brimhaven. |
| Brimhaven → Ardougne | Same customs-officer script, selecting destination by NPC x-coordinate | Members' geography, search restrictions and 30 coins | Native customs/payment/sailing and disembarkation at Ardougne. |
| Fishing Contest tunnel, either direction | `quests/quest_fishingcompo/scripts/quest_fishingcompo.rs2` | Members' world and `%fishingcompo == 5`; no fare. Uncompleted characters are rejected by route selection and the entrance's native script retains its own check. | Click the native entrance stairs, walk through the real underground passage and click the corresponding exit stairs. |

`interface_boat/scripts/sail.rs2` implements the seven-tick sailing delay and ship-deck arrival. `general_use/scripts/gangplank.rs2` implements boarding/disembarkation. The controller waits for the script and dialogues to settle, then confirms the expected shore vicinity and level before advancing to the next leg. Its script-driven movements are normal game transportation, not recovery teleports.

The Gnome gate's existing native Femi interaction is also supported: the bot may choose “OK then.” and perform the scripted help interaction. Navigation does not set the access variable or complete Grand Tree itself. Other quest restrictions remain the game's responsibility and may defer a task.

## Route selection and money

`BotTravel.ts` separates the method registry, journey choice and native execution from the existing walking/gateway layer. The registry describes directions, boarding points, expected arrivals, NPCs/locs and native fares. More methods can be added at this boundary without replacing task planning, collision or persistence.

For the White Wolf Mountain corridor, alternatives are walking, the quest-qualified tunnel and the two-boat route through Karamja/Brimhaven. Selection considers combat level, **current** defence and hitpoints, equipped stab defence (the wolf damage style in this content), carried food, coins, distance, estimated travel time, run energy, agility, membership, quest state and the existing personality's combat-weight share.

This is a conservative preference heuristic, not an exact combat forecast. It uses an exposure budget of `90 / (1 + combat/20 + currentDefence/20 + nonnegativeStabDefence/60)`, a conservative three-hitpoint estimate per carried food unit, and personality-adjusted available health. Estimated speed incorporates run energy and agility. Walking and sea candidates compare distance/time, exposure and a wealth-sensitive monetary cost. There is no fixed combat-level eligibility threshold. A wounded strong character can reject walking, while a healthy, defended character can walk without coins. Extremely vulnerable characters can reject even the island transfer.

Funds must be **carried**, and are checked again before each leg. A one-boat outward journey reserves 60 coins for out and back; crossing between eastern and western mainland by two ships reserves 120 coins for the round trip. The journey remembers its origin so the reserved 60 coins can fund the return, rather than incorrectly demanding another full outward-and-return budget. Unaffordable or unsafe journeys defer the task through the existing planner; routing does not add currency, items or XP to make them possible.

Each leg issues one native click and retains ownership through dialogue and delay. Repeated walking requests do not issue another payment interaction. A 120-tick transport guard covers refused/stalled interactions, including blocked disembarkation. An observed payment with unconfirmed arrival is quarantined; retrying that method at the source cannot charge a second fare. There are no automatic refunds or compensating teleports.

## Regression and persistence validation

The combined playerbot, native-runtime, persistence and build-integrity suite passed **32 tests, zero failures**: 18 reliability cases, four native-runtime fixtures, five persistence cases and five integrity cases including their parent. The transport fixture was subsequently expanded to cover Barnaby's alternate menu, the plantation customs branch and the reverse tunnel; that fixture alone was rerun and passed all **18 internal scenarios**. The later focused gate-verification correction below has separate regression validation; the retained population runs measure the earlier production source at `1a0ba61`.

The completed reproductions against the original PR #4 head establish the travelling-watchdog and oversized-waypoint failures described above. The original manager also fails the fresh-quest-state assertion. The older environmental reproductions remain in the historical report.

The added journey fixture uses actual r254 maps, locs, NPCs, interface components and scripts. It includes:

- Both ship routes in both directions, exact 30-coin deductions and confirmed ground-level arrivals.
- Interrupted payment and blocked disembarkation, with duplicate fare suppression.
- The Dragon Slayer three-option sailor menu at both captains, ordinary and plantation-worker customs choices, rum rejection and membership restrictions.
- Affordable and unaffordable travel, return-fare reservation, food/equipment/health/personality/energy assessment, and quest-qualified versus unqualified tunnel access.
- The Rimmington/mainland versus Musa Point/Brimhaven boundary.
- Falador → Taverley → White Wolf Mountain → Catherby beyond 300 ticks, Varrock → Gnome course, and a low-level Lumbridge → Gnome → Lumbridge round trip using four native paid boat legs.
- A real blocked bank destination and stationary inactivity, both still exhausting bounded recovery.

Character inventory/quest assignments in fixtures represent starting or loaded test data; production routing never creates those funds or quest completions. The persistence fixture additionally checks that fresh configured bots are not granted access flags and that saved completed/partial quest state survives shutdown/restart. The existing environmental fixtures still exercise doors, locked barriers, stairs, ladders, a complete Gnome lap and the northern Al Kharid route.

Run in an assembled disposable engine:

```sh
node --import tsx --test tests/bot-reliability.test.ts tests/bot-runtime.test.ts \
  tests/persistence-runtime.test.ts tests/build-integrity.test.ts
```

The final TypeScript check retains the same eleven pre-existing protocol diagnostics as the base, with normalized diagnostics unchanged. New travel, dialogue and region modules pass focused ESLint checks.

## Focused gate and oscillation review

The [focused diagnostic results](playerbot-gate-review-results.json) retain the measured distances, native script times, before/after reproduction and actual movement cycles. This follow-up changes only the side used to verify a door crossing; **the 25-tick deadline still starts when the interaction is queued**. Retry budgets, cooldowns, gate search radii, collision and the oscillation detector are unchanged.

### Calling distances, movement and visibility

The main path fallback calls `openGateToward(..., 8)`; most skilling/banking recovery calls use `openNearbyGate(..., 5)` or `8`. Some combat, bankstand and vendor recovery calls explicitly request 12, 20 or 30. The shared loc finder uses Manhattan distance up to twice its requested radius, within the zones it visits, so a radius of 8 does not guarantee an eight-tile maximum. Generic floor-gateway searches are centered on the approach tile after the bot has approached it.

`tryObstacle` starts in WALK mode. Native `Player.updateMovement` then uses persistent run state and a valid run animation; walking advances one tile per tick and running up to two, subject to collision and energy. The measured examples include actual approach detours and native script dispatch:

| Real-map interaction | Initial Chebyshev distance | Approach path steps | Native script starts | Result |
| --- | ---: | ---: | ---: | --- |
| Sheep gate from `(3213,3253)` walking | 8 | 7 | tick 8 | Verified at tick 8 |
| Sheep gate from its non-operable side `(3214,3261)` | 1 | 1 | tick 2 | Verified at tick 2 |
| Cow gate at `(3241,3301)` running | 4 | 4 | tick 3 | Verified at tick 3 |
| Locked Varrock door at `(3273,3417)` | 0 | 0 | tick 1 | Still locked; bounded failure at tick 25 |
| Tutorial Island door from `(3097,3107)` | 1 | 0 | tick 1 | Native refusal; bounded failure at tick 25 |

These cases provide no evidence that starting the timer at queueing is itself defective. The Gnome south-gate probe also shows Femi's initial dialogue/help sequence finishing outside the gate: access establishment is not passage. A north-side interaction that can pass dispatches at tick 4 and verifies at tick 6.

The actual r254 scenery handler checks the client's **104-tile build area**, rejecting clicks outside `originX/originZ ±52`. That is distinct from NPC draw distance. These probes do not establish that the normal short-range gate searches acquire objects outside that area. The wider generic recovery searches deserve a future gate-specific build-area check if such a violation is reproduced; imposing an arbitrary NPC-style radius or changing the shared resource loc finder is not justified by this evidence. No acquisition-policy change is included here.

### Reproduced verification defect

From `(3203,3174)`, a radius-5 search selects the native `zanarisdoor` at `(3202,3169)`. The valid five-step approach goes around to `(3201,3169)`, on the opposite side from the queueing position. Its native `open_and_close_door2` script starts at tick 6 and carries the character through to `(3202,3169)`, temporarily replacing the original door with an invisible wall.

Previously, verification compared the final position with the **queueing** side and tested the temporarily blocked edge. It missed the completed native crossing and reported failure at tick 25. The new regression fails on `ef8f9fe`. Recording the validated **operating** position as the crossing source verifies success at tick 6. The original barrier must still change; this does not authorize passage through a locked or unchanged door. No quest flag, item, XP, fare or recovery teleport is changed.

The independent population observer also requires an open collision edge for a gate opening; native doors that temporarily replace themselves with invisible walls can therefore remain "unverified" even after a scripted crossing. That metric is not interchangeable with production obstacle-timeout reports. The existing measurements are retained without relabeling successful results or changing the observer to improve a score. This single reproduction does not explain every additional report.

### Oscillation evidence and validation boundary

Rate-limited population logs contain 44 emitted oscillation lines before and 88 after, versus raw observer counts of 69 and 135. Combat accounts for 31 and 65 emitted lines respectively; Mine accounts for 12 and 23, with one baseline ShopTrip line. Emitted logs do not provide complete position histories and cannot establish the cause of the raw increase.

A small diagnostic using three selected characters and 1,000 full native world ticks captures two actual Mining approach cycles: `(3285,3363) ↔ (3285,3364)` and `(3286,3365) ↔ (3284,3365)`, each repeated three times. Its task goals alternate among nearby rocks. This confirms real movement/reselection, not stationary false positives. Recovery remains bounded and the miner subsequently earns 6,300 internal Mining XP. The two Combat probes do not reproduce an oscillation; their absence in this small diagnostic does not resolve the population Combat increase. Resource-target retention and broader combat investigation remain documented work rather than changes to the detector in this patch.

The complete **32-test playerbot, persistence and r254-integrity suite passes again**, including the new actual-map crossing regression and existing locked doors, floor transitions and transportation tests. The completed 100-bot comparisons below are preserved, explicitly measuring source `1a0ba61` before this follow-up. They do not measure this correction's aggregate effect; no additional full population simulations were run for this narrow change.

## Comparable 100-bot validation

The comparator is the original PR #4 implementation at `4577f6114c8401140726a61ceedf5e938cc3b180`, rather than original `dev`. Its two successful baseline runs were retained. Only the corrected populations were rerun after removing the quest/access overrides. Intermediate corrected runs that still granted quests are excluded from this comparison.

Each version uses seeds 254 and 255, 100 configured bots, 6,000 complete world ticks, fresh SQLite databases and fresh `bot-simulation` saves. The final corrected measured runs were sequential without concurrent tests or builds. Both versions use identical original r254 content/packs, dependencies, starting configuration and the same observer harness (`061df21f9c473b0b37d078dae195885d13bb50afd75da2bb336edd6d4d55f9ff`). All runtime source files were checked against the common assembled engine plus the corresponding PR source overlay; all map/script hashes match the historical runs.

Use the existing disposable-runtime assembly and safety procedure in [playerbot-reliability.md](playerbot-reliability.md), copy this PR's `tools/bot/simulate.ts` into both implementations, and run each seed in a fresh runtime:

```sh
NODE_PROFILE=bot-simulation DB_BACKEND=sqlite NODE_PRODUCTION=true \
ENGINE_REVISION=254 NODE_XPRATE=1 NODE_PROGRESSIVE_XP=false \
BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true \
BOT_DEBUG_ENABLED=false BOT_LOG_LEVEL=info BOT_LOG_RATE_TICKS=100 \
BOT_LOG_SUMMARY_TICKS=100 BOT_SIM_SEED=254 BOT_SIM_TICKS=6000 \
BOT_SIM_INTERVAL_MS=0 BOT_SIM_LABEL=before-or-after \
BOT_SIM_OUTPUT=/absolute/path/results.json \
node --import tsx tools/bot/simulate.ts
```

The harness refuses human accounts, existing simulation saves or a missing disposable-runtime marker. Each run retained 100 active bots and 100 accounts, passed all 100 save round trips (CRC, XP, coordinates and permanent inventories), and returned SQLite `quick_check: ok`: **400 verified saves overall**. A separate read-only audit loaded all 400 saves without initializing BotManager, advancing the world or writing saves.

The [machine-readable comparison](playerbot-land-transport-simulation-results.json) includes source fingerprints, native fares, per-leg usage, participation, exact requested-tile arrivals, raw failures, task completions, XP and persistence/timing results. `BotManager.ts` and the shared polygon module are fingerprinted in the comparison metadata in addition to the in-harness production fingerprint list.

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Active bots / verified saves | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 |
| Exact requested-tile arrivals | 3,701 | 3,863 | 3,234 | 3,976 |
| Idle bot frames | 26,635 | 17,800 | 31,746 | 15,224 |
| Travel bot frames | 267,533 | 270,040 | 261,169 | 276,783 |
| Support bot frames | 236 | 227 | 245 | 160 |
| Activity-state bot frames | 305,596 | 311,933 | 306,840 | 307,833 |
| Progression-bot activity frames | 115,795 | 124,220 | 120,427 | 117,808 |
| Frames with native-script XP | 7,568 | 10,091 | 7,826 | 9,151 |
| Agility-task frames (includes travel) | 34,850 | 25,368 | 36,371 | 26,874 |
| Progression bots with native-script XP | 52 | 52 | 52 | 52 |
| Progression-bot native-script XP | 33,417.2 | 47,623.1 | 32,475.0 | 49,173.8 |
| All-bot native-script XP | 167,473.9 | 209,780.0 | 161,891.2 | 171,031.0 |
| All-bot action XP / level gains | 170,476.9 / 266 | 213,878.0 / 370 | 165,068.2 / 256 | 174,558.0 / 382 |
| Recorded Init completions | 52 | 52 | 52 | 52 |
| Recorded ShopTrip completions | 267 | 212 | 267 | 185 |
| Recorded Bank completions | 3 | 2 | 0 | 0 |
| Recorded Idle completions | 882 | 589 | 1,053 | 504 |
| Recorded Agility completions | 0 | 0 | 0 | 0 |

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Native gate clicks / script starts | 1,017 / 477 | 1,382 / 595 | 995 / 449 | 1,359 / 585 |
| Observed gate openings / unverified outcomes | 447 / 30 | 517 / 78 | 419 / 30 | 507 / 78 |
| Transition scripts / observed completions | 0 / 0 | 264 / 257 | 0 / 0 | 234 / 226 |
| Raw path failures | 175 | 272 | 314 | 165 |
| No-progress failures | 15 | 9 | 10 | 8 |
| Oscillation recovery reports | 38 | 72 | 31 | 63 |
| Walking-stuck recovery reports | 821 | 474 | 571 | 434 |
| Task deferrals | 705 | 449 | 668 | 462 |
| Raw timeout diagnostics | 378 | 659 | 402 | 548 |
| Error logs | 0 | 0 | 0 | 0 |

| Native leg | 254 starts / arrivals / coins | 255 starts / arrivals / coins |
| --- | ---: | ---: |
| Port Sarim → Musa Point | 32 / 32 / 960 | 41 / 39 / 1170 |
| Musa Point → Port Sarim | 20 / 20 / 600 | 26 / 26 / 780 |
| Ardougne → Brimhaven | 12 / 12 / 360 | 15 / 15 / 450 |
| Brimhaven → Ardougne | 22 / 22 / 660 | 25 / 24 / 720 |

The baselines have no native transport use or fares. Corrected populations start 193 ship legs, confirm 190 arrivals and pay **5,700 coins**, exactly 30 per paid leg. The other three starts are bounded pre-payment stalls in seed 255, at Sarim twice and Brimhaven once; their timeout messages contain no payment-observed marker. No corrected population is eligible for the Fishing Contest tunnel, so it is exercised by the completed-save fixture instead.

| Metric | 254 before | 254 after | 255 before | 255 after |
| --- | ---: | ---: | ---: | ---: |
| Steady world mean / p95 / max (ms) | 12.53 / 18.30 / 261.72 | 14.02 / 19.16 / 260.50 | 12.33 / 17.51 / 216.62 | 12.88 / 18.00 / 268.74 |
| Steady bot mean / p95 / max (ms) | 2.87 / 7.34 / 85.52 | 3.21 / 7.07 / 51.14 | 2.84 / 7.15 / 40.01 | 3.16 / 7.32 / 49.23 |
| Startup-inclusive world maximum (ms) | 3542.87 | 3445.24 | 3937.77 | 3352.03 |
| World ticks >600ms: startup / steady | 1 / 0 | 1 / 0 | 1 / 0 | 1 / 0 |
| Wall seconds including save checks | 86.02 | 94.81 | 85.31 | 87.83 |

Across the paired seeds, exact requested-tile arrivals increase **13.0%** (6,935 → 7,839), idle frames fall **43.4%** (58,381 → 33,024), and deferrals fall **33.6%** (1,373 → 911). Walking-stuck recovery reports fall **34.8%** (1,392 → 908). All 52 progression bots earn native-script XP in every run; their combined native-script XP rises **46.9%** (65,892.2 → 96,796.9). All-bot native-script XP rises 15.6%, and frames with native-script XP rise 25.0%. These are improved action/participation measures, not proof that every destination or task is reachable.

Results remain mixed. Raw path failures fall 10.6% overall (489 → 437), but seed 254 worsens (175 → 272). Oscillation recovery reports increase from 69 to 135, with zero stationary-only false positives. Gate interactions increase, and unverified gate-script outcomes rise from 60 to 156. Some ship approaches still stall before payment; the existing bounds defer them. There is no universal failure reduction.

Agility-task frames fall **26.6%** (71,221 → 52,242). The corrected populations dispatch native transitions, but the displacement counter also includes gangplanks and cannot be read as completed agility laps. Neither version records a ten-lap Agility task completion in this continuation comparison. Long journeys to Gnome and a complete script-earned Gnome lap pass targeted fixtures; the population evidence does not establish consistently productive agility participation. ShopTrip completions also fall (534 → 397), while Idle completions fall (1,935 → 1,093). Ongoing skill/social tasks and idle/support completions must not be combined into a productive task-throughput claim.

The saved access audit shows Fishing Contest `5`, Grand Tree `160`, Femi `2` and Barcrawl `2` for every baseline bot. All corrected bots retain Fishing Contest, Grand Tree and Barcrawl `0`; Femi remains `0` except for six bots in seed 254 and five in seed 255 that use her native help interaction. The comparison therefore includes restoring legitimate access policy, alongside the route/progress changes. It does not attribute the agility-frame reduction to one isolated cause.

Steady world mean processing increases from 12.53 → 14.02ms and 12.33 → 12.88ms; bot mean processing also increases. All four steady samples remain below the 600ms tick budget, with one startup overrun in each run. Changed activity and transport work preclude claiming an algorithmic speedup. Broader access, oscillation/obstacle failures and population agility remain explicit review limitations; PR #4 remains unmerged.

### Measurement limits

- Requested-tile arrivals are observed through the same request/position methods in both versions. They include repositioning and are not unique task completions; tasks that accept a radius can finish without reaching the exact tile.
- Idle, travel, support and activity-state frames partition bot ticks. Activity-state frames can include waiting/cooldowns and social tasks; they are not all productive work. Native-script XP frames and XP totals provide a separate action measure. Script XP excludes the pre-existing task-switch XP callback; existing starting stats/inventory policies are unchanged.
- Transportation starts, confirmed arrivals and observed native fare deductions are separate. An in-flight final leg need not have a confirmed arrival at the experiment cutoff. The fresh corrected populations have no manufactured Fishing Contest completion; tunnel eligibility remains exercised by the completed-save fixture.
- The comparison includes removal of automatic quest/access grants as an intended correctness fix. It is not an isolated pathfinder microbenchmark: native restrictions change available activities, and changed decisions/random-number consumption/wall-clock task timers change later trajectories.
- These are accelerated managed-host runs. Six thousand full world ticks represent one game hour; the production 600ms constant is unchanged. Startup outliers are separated from steady timing. Paced VM/browser/network behavior and a long soak are unmeasured.

## Remaining limitations

The risk estimate is specific to the audited mountain alternatives, not a complete threat atlas of Gielinor. It does not predict exact monster damage, automatically consume food, or promise that the Karamja transfer is risk-free. Selection is stable for a journey rather than recalculated every tick. Other methods and quest routes remain bounded/deferred when the existing graph or requirements cannot support them; this phase does not add a quest-solving system.

Experienced bots should eventually have varied, plausible quest histories. A future, separate change could initialize quest history **once when creating a new character**, from that character's profile, respecting quest prerequisites and then persisting the result. Existing saves and partial progress must remain untouched; login must never reapply initialization. This opportunity does not authorize unconditional quest completion, and implementing quest diversity is outside PR #4.

Journey intent, origin/return reservations and ambiguous-payment quarantine are transient bot-session state. Character saves retain their existing format, but crash recovery in the middle of a paid voyage has not been validated with a durable transport receipt ledger. No refund or recovery teleport is added for that ambiguity. Existing unrelated task-specific travel/startup policies outside these corrections remain outside this report.
