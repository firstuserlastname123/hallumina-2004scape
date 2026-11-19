# Melee training on Progressive r254

## Encounter behavior

The planner counts the required weapon in the backpack or worn equipment for eligibility, purchase planning and affordability. The attack step uses current melee levels, remaining HP, worn weapon and protective slots, carried food and the NPC’s visible level to screen enemies. The thresholds are conservative training heuristics. An injured bot uses its own food through the held-item operation or walks toward supplies.

Within the local search area, Combat compares up to twelve available attackable NPCs. An immediately operable opponent takes priority. For other candidates, the r254 entity path must end on a legal melee face, and its steps must pass the bot’s collision checks. The bot ranks these routes by walking distance and claims the selected NPC by its stable slot. If no candidate is reachable it can try a directional gate, switch training areas, or defer. Unsupported dungeon access also defers.

Once the bot dispatches Attack, ordinary misses leave the native interaction running. A stalled approach or extended damage drought releases the claim, suppresses that target temporarily and returns to search. Native death and hero credit determine whether the bot advances its training style. It uses the weapon interface for the next style, the ground-object operation for visible drops and the held-item operation to bury bones. Empty loot returns directly to search. Only native scripts award melee XP. Travel uses the shared navigation progress signal and stall recovery. Combat timeouts begin after target acquisition.

The melee bank trip requires an open bank interface. Supplies move through native deposit and withdrawal scripts, which enforce ownership, available space and item restrictions. The r254 content files and persistence format require no changes.

## Focused reproductions

Run from an assembled and integrity-verified Progressive r254 engine. Each new probe creates a fresh temporary SQLite profile.

```sh
node --import tsx --test --test-concurrency=1 tests/bot-melee.test.ts tests/bot-runtime.test.ts tests/bot-reliability.test.ts
node --import tsx --test --test-concurrency=1 tests/build-integrity.test.ts tests/persistence-runtime.test.ts
```

For a tick trace, run `node --import tsx tools/bot/investigate-combat.ts world`. The other regression modes are `decisions`, `geared`, `travel-fit`, `bank` and `retreat`.

| Fixture | Merged dev | PR #5 |
| --- | --- | --- |
| Falador | Equipping the sole qualifying scimitar caused a requirements deferral on the next tick. A foodless combat-level-7 trainee accepted a level-21 guard. | The worn scimitar satisfies eligibility and purchase checks. The trainee declines the guard. |
| Injury | Combat read 11,540 internal XP as current health after a character took eight damage. | Combat sees 2/10 HP. A foodless bot retreats. A logged-in bot consumes its shrimp and reaches 5 HP through the food script. |
| Edgeville | The adjacent `man2` across a blocked edge outranked a reachable `man3`. | The selected approach ends at the legal attack position (3101,3510). |
| Lumbridge chicken pen, 200 ticks | The bot opened scenery during a legal fight. Two kills yielded 24 native melee XP, 7.8 native Hitpoints XP and 12 task-awarded melee XP. | The bot opens the pen before engagement, fights successive chickens and receives native drops. Three kills and a fourth attack yield 48 native melee XP, 15.6 native Hitpoints XP and zero task-awarded melee XP. Attack, Strength and Defence all advance. |
| Empty loot | Eleven no-attack timeouts and zero searches before deferral at tick 150. | The task returns to search within four ticks with zero no-attack timeouts. |
| Fit traveller | Combat deferred at tick 300 after 297 ticks of movement and no attempted encounter. | The character continues on its route beyond tick 300. |
| Draynor bank | The old melee resupply code directly edited inventory containers. | At a real booth a fixture deposits one bone and 71 surplus coins, keeps 200 coins and withdraws six owned shrimp. |

[Baseline traces and secondary findings](playerbot-combat-investigation.md)

## Paired population comparison before the navigation follow-up

Each run used 100 configured bots, 2,000 full world ticks, seed 254 or 255, the same verified packs, 1× XP and an empty, disposable SQLite and save profile. Both checkouts ran the same simulation observer. All four runs finished with 100 active bots, 100 verified saves, SQLite quick-check OK and zero bot errors. The original 32 tests and five new melee tests passed. TypeScript still reports the 11 previously documented client protocol errors.

| Observation | Dev 254 | PR 254 | Dev 255 | PR 255 |
| --- | ---: | ---: | ---: | ---: |
| Damaging melee engagements | 113 | 164 | 67 | 152 |
| Native hero-credited NPC kills | 87 | 139 | 43 | 122 |
| Native melee XP | 1,892 | 2,456 | 1,204 | 2,216 |
| Task-awarded melee XP | 936 | 0 | 592 | 0 |
| Local searches returning no target | 1,738 | 74 | 1,917 | 89 |
| Approach timeouts | 136 | 55 | 90 | 61 |
| No-attack timeouts | 157 | 0 | 179 | 1 |
| Measured progress increments during Combat travel | 2,396 | 3,796 | 2,760 | 2,771 |
| Combat task deferrals | 57 | 57 | 57 | 58 |
| All task deferrals | 145 | 152 | 137 | 155 |
| All navigation no-progress events | 3 | 49 | 5 | 51 |
| All walking-stuck recoveries | 150 | 165 | 161 | 159 |
| All obstacle failures | 152 | 18 | 149 | 21 |
| All navigation oscillations | 19 | 2 | 17 | 6 |
| Native XP across all skills | 61,251.3 | 69,924.8 | 68,895.9 | 52,110.0 |

A damaging engagement is the first positive native Attack, Strength or Defence award per bot and NPC life while on Combat. A kill requires an observed participant to be the native hero at zero-HP removal. XP is in displayed game units. Empty searches count local selector calls, so changes in scanning frequency affect the totals. The old no-attack counter included kills and null targets. The new counter counts a damage drought inside an encounter. Navigation progress counts increases of the existing meaningful-travel serial during the walk to training.

Across both seeds the bots recorded 261 kills versus 130, and gained 4,672 native melee XP versus 3,096. Both measures increased on each seed. Overall task deferrals rose from 282 to 307 and navigation no-progress events from 8 to 100. For example, the changed seed-254 log shows several Combat travellers stalled around (3092,3106) at ticks 103–105 and subsequently deferred by the activity watchdog. This remains a limitation for reaching the mainland from some fresh starting positions. The measured long-distance traveller fixture covers a separate journey with actual forward progress. The two seeds also disagreed on total native XP across all skills, with a combined decline of 6.2%.

These accelerated runs include existing wall-clock timers. Changed choices consume randomness in a different order. They give two paired observations of population participation. Long-term progression, manual gameplay and a restart in the user's latest live VM session still require live evidence. Agility accounting and character initialization remain follow-ups.

To repeat the comparison, follow the disposable simulation setup for each checkout and seed, copy the same observer into both, and set `BOT_SIM_TICKS=2000`, `BOT_SIM_SEED=254` or `255` and `BOT_SIM_INTERVAL_MS=0`. [Simulation setup](playerbot-reliability.md) · [Measured run data and source hashes](playerbot-melee-simulation-results.json)


## Tutorial Island and combat retreat follow-up

The logs place 89 of the original PR's 100 navigation no-progress events on Tutorial Island. Merged dev logged five of its eight events there. The remaining mainland counts were three and eleven respectively. The repeated coordinates around (3092,3106) match the default new character area in r254.

Starting at (3092,3106) for Edgeville, the native pathfinder returned zero waypoints. At the original PR head, an exact destination and the normal per-slot jittered destination each produced one no-progress event while the bot remained on the island. At the merged dev baseline, the same Combat start scheduled a recovery teleport at tick 90 and then approached targets in Edgeville. The legacy recovery masked the missing mainland route. The tutorial exit script also resets stats, worn gear and bank contents, so general travel cannot use that script as a crossing for existing characters.

The planner now recognizes the native island and mine bounds and rejects unsupported crossings before queuing a partial land route. On-island walking remains available. The journey fixture checks both directions, an exact and jittered Combat destination, an upstairs mainland bank and the tutorial mine. It also verifies that the rejection leaves coordinates and progression flags intact.

The old retreat expired after 30 moving ticks and 21 measured progress increments on the real route from (3034,3235) to Draynor. Combat now treats 30 ticks as an inactivity limit, using shared route progress and retaining the chosen bank across the journey. Bank walking uses the shared retry system. In the new fixture the injured bot walks for 47 ticks, reaches (3092,3245) and withdraws six owned shrimp through the native bank interface. A stationary retreat still defers on its 30th active tick.

The follow-up used the same seed 254 and 255 setups, 100 bots and 2,000 ticks per run. All 38 tests passed, including the original 32 tests and the six melee probes. Both follow-up simulations finished with 100 active bots, 100 verified saves, SQLite quick-check OK and zero bot errors.

| Observation | Original PR 254 | Follow-up 254 | Original PR 255 | Follow-up 255 |
| --- | ---: | ---: | ---: | ---: |
| Navigation no-progress events | 49 | 6 | 51 | 5 |
| Emitted Tutorial Island no-progress events | 48 | 0 | 41 | 0 |
| Emitted unsupported tutorial crossing deferrals | 0 | 44 | 0 | 45 |
| Combat task deferrals | 57 | 73 | 58 | 61 |
| All task deferrals | 152 | 345 | 155 | 341 |
| Damaging melee engagements | 164 | 239 | 152 | 159 |
| Native hero-credited kills | 139 | 201 | 122 | 121 |
| Native melee XP | 2,456 | 3,696 | 2,216 | 2,528 |
| Task-awarded melee XP | 0 | 0 | 0 | 0 |

The follow-up replaces the island stalls with explicit route refusals. It does not establish a mainland route for characters that start on Tutorial Island. Total task deferrals rose from 307 to 686 across the two seeds, including repeated crafting and activity-watchdog failures. These runs do not attribute the full increase to the island guard. Eleven mainland no-progress events still occurred. [Machine-readable results](playerbot-melee-simulation-results.json)
