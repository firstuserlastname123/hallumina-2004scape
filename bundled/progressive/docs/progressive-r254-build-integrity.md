# Progressive r254 build integrity

## Cause

The compact manager extracts the vanilla revision-254 snapshot from
`store/manifests/254.json`, then copies `bundled/progressive` over it. The bundle
previously supplied custom content without supplying the matching checksum
expectations in the inherited packers.

In particular, `content/pack/npc.pack` extends the original IDs 0–1161 with IDs
1163–1174 (1162 remains unused). These include `king_dragon_pet`,
`kalphite_queen_pet`, `chaos_elemental_pet`, `giant_mole_pet`, and `scorpia_pet`.
The definitions are under `content/scripts/areas`, including the appended pet
blocks in `area_wilderness/configs/king_dragon.npc` and
`area_kalphite/configs/kalphite.npc`. The NPC packer serializes all these IDs into
the client `npc.dat`, while the inherited validator still expected the vanilla
NPC checksum.

Repacking the original NPC definitions and ID map directly from the compact
store produces 1,162 entries and CRC32 `1077655221`, exactly the inherited
expectation. The bundled definitions produce 1,175 entries and CRC32
`-273855550`. Thus this is a build integration defect: stale vanilla checksum
expectations for intentionally extended Progressive content. It is not stale
generated cache data, a wrong game revision, or a malformed pet definition.
Deleting generated packs alone reproduces the failure.

The item and interface packs also contain existing Progressive changes, so
correcting only the NPC checksum would expose the next two mismatches.

## Reproduction and full error

From the repository root before the fix:

```sh
node launcher/launcher.js --build progressive-254
cd runtime/active/engine
npm ci
BUILD_VERIFY=true BUILD_VERBOSE=true npm run build
```

The captured verbose build exited with status 1:

```text
> engine-ts@1.0.0 build
> tsx tools/pack/Build.ts

11/5/2026 5:18:17 PM	 ERROR	 .npc checksum mismatch!
You can disable this safety check by setting BUILD_VERIFY=false
Error: .npc checksum mismatch!
You can disable this safety check by setting BUILD_VERIFY=false
    at readConfigs (/workspace/hallumina-2004scape/runtime/active/engine/tools/pack/config/PackShared.ts:253:15)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async packConfigs (/workspace/hallumina-2004scape/runtime/active/engine/tools/pack/config/PackShared.ts:523:9)
    at async packAll (/workspace/hallumina-2004scape/runtime/active/engine/tools/pack/PackAll.ts:42:5)
    at async <anonymous> (/workspace/hallumina-2004scape/runtime/active/engine/tools/pack/Build.ts:7:5)
```

The timestamp above is the build process's UTC host clock. The suggestion to
disable validation is part of the original error, not the remedy used here.

## Fix

Add Progressive overlay copies of the two inherited packers, changing only the
three affected fixed CRC32 expectations and adding explanatory comments:

| Packed client data | Vanilla r254 CRC32 | Bundled Progressive r254 CRC32 | Packer |
| --- | ---: | ---: | --- |
| NPC definitions | 1077655221 | -273855550 | `engine/tools/pack/config/PackShared.ts` |
| Item definitions | 535204494 | 480980405 | `engine/tools/pack/config/PackShared.ts` |
| Interfaces | 1728499832 | -892678262 | `engine/tools/pack/interface/PackClient.ts` |

These are fixed checksums for the existing bundled content, not values accepted
or generated automatically during a build. `BUILD_VERIFY` still defaults to
true, and every original validation branch remains active. The compact store,
revision selection, NPC/item IDs, gameplay sources, and playerbot code are
unchanged. Vanilla modes continue to use the packers from their store snapshot.
The full packer files are present in this diff because the manager applies file
overlays rather than source patches.

## Verification

After reassembling Progressive r254, run from `runtime/active/engine`:

```sh
BUILD_VERIFY=true npm run clean
BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true npm run build
node --import tsx --test tests/build-integrity.test.ts
npm run sqlite:migrate
BUILD_VERIFY=true ENGINE_REVISION=254 npm run quickstart
```

The integration test copies content into an isolated temporary engine/content
layout, starts every case without generated packs, and runs the actual build.
It checks that the bundle produces server scripts and the on-demand cache, then
checks that independent edits to a boss pet NPC, its item, and a shop interface
fail their respective checksum validations. It removes all temporary files.

Validation on Node 24.22.1 and Bun 1.4.4:

- Clean content and RuneScript server build passed with all integrity flags true.
- Web client rebuild passed with Bun; its outputs were copied into the server.
- All four integration cases passed (five Node test results including the parent).
- ESLint passed for both packers and the integration test.
- SQLite migration succeeded through Prisma.
- The server reached `World ready`, loaded 6,274 static NPCs, initialized all
  100 configured playerbots, and ran through at least 78 bot ticks. The web client
  page and JavaScript returned HTTP 200; TCP port 43594 accepted a connection.
  Graceful shutdown completed.

Limits and existing issues:

- The content build warns about missing `model_434_npc` and `model_2925_npc`.
- `tsc --noEmit` reports existing network message type errors in the EventAppletFocus,
  EventCameraPosition, EventMouseClick, EventMouseMove, and ReportAbuse codecs and
  handlers. The unfixed inherited packers produce identical diagnostics. These
  are outside this checksum fix; the runtime/content build passes.
- Interactive client login, pet interactions, optional Grand Exchange staging,
  long-running bot progression, and Windows/macOS startup were not exercised.
