# Progressive r254 persistence and administration

These instructions describe the `dev` Compact Manager and bundled Progressive
engine. Progressive remains revision **254**, with save version **7** and the
existing CRC. There is no character migration or database schema change.

## Saving and shutdown

The world already autosaves every 1,500 ticks (15 minutes at 600 ms/tick).
Human characters and headless playerbots use the same `Player.save()` format and
logout queue. BotManager stops taking actions during the final 50 ticks and
loads its normalized character names from the same profile on the next start.
Bot planners/tasks are reconstructed on startup; transient AI tasks are not saved.
The bot population monitor and debugger remain unchanged.

Both local LoginThread (`LOGIN_SERVER=false`) and central LoginServer now validate
CRC and replace saves through a unique temporary file beside the destination:
write, flush the file, close, rename over `.sav`, and flush the containing
directory on POSIX. An error before rename leaves the previous `.sav` intact.
Windows uses the same replacement operation but Node does not offer directory
fsync there. This protects against interrupted writes; it cannot promise recovery
from faulty storage or a filesystem that does not honor flush/atomic rename.
Do not put player saves on a filesystem without those guarantees.

The serialized bytes and `.sav` filename stay unchanged. New files are private
(mode 0600 on POSIX). A killed process can leave a `*.sav.*.tmp` file; it is never
loaded as a character. Once all writers are stopped, these orphan temporary files
may be removed. Keep the `.sav` and normal backup copies.

Saves for each character run in order. The central server also retains its
existing playtime regression check. A logout success is sent only after file
persistence and, centrally, hiscore/session updates finish. Validation, disk and
DB failures report failure; the world retains the in-memory snapshot and retries
every 15 seconds. Reconnects cannot discard pending snapshots after the hop timer.
A successful save followed by a DB failure is safe to retry. File and DB updates
are not a single cross-resource transaction.

SIGINT, SIGTERM and SIGHUP already enter the world's graceful shutdown path.
`::reboot` and expiration of `::slowreboot` use that same drain. It waits until
there are zero online characters and zero unacknowledged logout saves before
exiting successfully. The existing forced-removal threshold still funnels players
through saving; it does not bypass acknowledgements. A persistent disk/DB failure
therefore prevents clean completion. Preserve the process and fix the storage
problem so the queued snapshots can retry; forcibly killing it loses unsaved RAM.
The game loop and native client countdown are unchanged.

Wait for **`Server shutdown complete`** and process exit before stopping a separate
login server, copying data, repairing/rebuilding, or restarting. Commands named
“reboot” stop the world for maintenance; restarting it is the manager/operator's
job. Stop any other database writers before an offline backup.

## Commands and permissions

Commands are entered with `::`. Checks use server-side `staffModLevel`.
Levels 0 and 1 cannot run the administrative commands below. Level 2 is the
super-moderator tier; level 3 is administrator; level 4 adds development commands
only when `NODE_PRODUCTION=false`. Privileged command invocations by level 2+
are added to the existing session log. This is the engine's command inventory;
optional plugins can expose additional commands.

| Command | Minimum level | Production-only | Behavior |
| --- | ---: | :---: | --- |
| `::broadcast <message>` | 3 | Yes | Broadcast text to the current world. |
| `::reboot` | 3 | Yes | Begin graceful shutdown immediately. |
| `::slowreboot <seconds>` | 3 | Yes | Schedule shutdown and show the native countdown; rounds up to a 600 ms tick (parse fallback 30 seconds). Use a positive duration. |
| `::cancelreboot` | 3 | Yes | Cancel a future countdown and send native timer 0 to clear it. Refuses if none is scheduled or draining has started. |
| `::setvar <variable> <value>`, `::getvar <variable>` | 3 | No | Set/read own varp or varbit. |
| `::setvarother <username> <variable> <value>`, `::getvarother <username> <variable>` | 3 | Yes | Set/read another online player's variable. |
| `::give <item> [count]`, `::givecrap`, `::givemany <item>` | 3 | No | Create items; givecrap generates random items, givemany adds up to 1,000. |
| `::giveother <username> <item> [count]` | 3 | Yes | Give items to another player. |
| `::setstat <skill> <level>`, `::advancestat <skill> <level>`, `::minme` | 3 | No | Change skills; minme resets to starting levels. |
| `::teleother <username>` | 3 | Yes | Bring another online player to you, when accessible. |
| `::locadd <name>`, `::npcadd <name>` | 3 | No | Spawn a temporary location/NPC at your position. |
| `::openmain <interface>`, `::openoverlay <interface>`, `::closeoverlay` | 3 | No | Open/close interface roots by config name. |
| `::snapshot` | 3 | No | Write a V8 heap snapshot to the process working directory. |
| `::serverdrop` | 3 | No | Terminate your connection to test reconnection. |
| `::getcoord`, `::tele <x> <z> [level]`, `::tele <level>,<mx>,<mz>[,<lx>,<lz>]`, `::tele up`, `::tele down` | 2 | No | Read coordinates or teleport. |
| `::teleto <username>`, `::setvis <0|1|2>` | 2 | Yes | Teleport to an online player; set default/soft/hard visibility. |
| `::ban <username> <minutes>`, `::mute <username> <minutes>`, `::kick <username>` | 2 | Yes | Existing moderation commands; durable bans/mutes require the central login server. |

There was no cancellation command, negative-duration cancellation convention, or
relay that cleared `shutdownTick`; `::cancelreboot` is the only new command.
It only cancels scheduled shutdown, before persistence draining starts.

### Configure an administrator safely

Use `NODE_PRODUCTION=true` in the active engine's `.env` (and any separately
started login/world processes). Non-production login deliberately grants **every
login level 4**, even when the account DB says otherwise. It is unsuitable for a
shared server. The old `.env.example` mentions `NODE_STAFF`; this engine does not
read it and it does not grant staff rights.

For authenticated administrator access, use the existing central login mode
(`LOGIN_SERVER=true`, with its normal login service running and the intended
`NODE_PROFILE`, default `main`). Local/standalone login does not authenticate
passwords or load account staff levels: production standalone logins get level 0.
Do not disable production mode to elevate a single account. Keep internal
login/management services on a trusted network and expose only intended player
services.

1. Register a normal account through the existing account registration flow;
   log in once, then log out. Never use a bot account (`!bot` password marker).
2. Shut down the world and all DB writers cleanly, then make a backup.
3. Open the **active** `runtime/active/engine/db.sqlite` in an SQLite editor.
   Select `id, username, staffmodlevel` from `account` and identify the exact
   normalized username (lowercase, underscores instead of spaces, at most 12
   characters). Verify the unique numeric ID before updating anything.
4. In a transaction, set **only that account's** `staffmodlevel` to `3`. For
   example, after verifying that ID 42 is your account:

   ```sql
   BEGIN IMMEDIATE;
   UPDATE account SET staffmodlevel = 3 WHERE id = 42;
   SELECT id, username, staffmodlevel FROM account WHERE id = 42;
   COMMIT;
   ```

   Substitute the verified ID; rollback if the result is unexpected. For a MySQL
   deployment use the same existing account column in its configured database,
   with its transaction syntax. No schema conversion is needed.
5. Restart, authenticate, and reconnect to pick up the role. Check a harmless
   `::getcoord` first. Grant the minimum needed role (2 for moderation, 3 for
   administration). Setting the role back to 0 and reconnecting revokes it.

Never edit `.sav` bytes to grant staff permissions: roles come from the account
DB, and manual byte edits break the save CRC. Protect backups since they contain
password hashes and configuration secrets.

## Existing Compact Manager backup and update procedures

Start the manager with `Run.bat` on Windows or `bash run.sh` on Unix.
The menu's **4. Backups** → **1. Progressive 254** creates a manual backup.
The manager first captures the matching active runtime into
`userdata/progressive-254/`, then copies it to
`userdata/backups/progressive-254/<timestamp>_manual/`. It retains the newest
**five** backup directories per mode/revision, including automatic pre-repair
backups. Copy important snapshots off-machine before retention prunes them.

The existing persistent paths in `launcher/manifest.json` are:

- `engine/.env`
- `engine/db.sqlite`, `engine/db.sqlite-wal`, `engine/db.sqlite-shm`
- `engine/data/players/` (humans and bots, all profiles)
- `engine/data/config/world.json`

The manager captures these after a launch finishes and before replacing the
active runtime. A matching existing runtime remains authoritative, so an
interrupted earlier launch does not restore stale cached userdata. When rebuilding
or switching revisions, the manager extracts the compact store, applies the
Progressive overlay for 254, and restores that mode/revision's userdata. Other
revisions have separate data directories. These copies are **offline backups**;
copying SQLite and WAL files independently while processes write is not a
consistent online backup. The menu does not stop a separately running server.

For a manual restore, stop all writers, keep an extra copy of the current active
and cached data, then replace the persistent paths as a set from one completed
backup in both `userdata/progressive-254/` and the matching active runtime. Remove
stale destination SQLite WAL/SHM sidecars before restoring the snapshot's files;
include the snapshot's sidecars if present. Do not mix a database from one snapshot
with WAL from another. The manager has no restore-selection menu. Verify the
restored human and bot progress before resuming play.

To update:

1. Gracefully stop the server, wait for completion, and create a backup.
2. Use **7. Check for updates**. The updater requires a Git checkout on `dev`,
   a configured `origin`, and no tracked local changes. It fetches `origin/dev`
   and fast-forwards only. ZIP installs, diverged history, and edited tracked
   files are not overwritten. It does not automatically create a pre-update
   backup or migrate data.
3. After a successful update, exit and restart Compact Manager as prompted.
   Launch Progressive 254; the changed overlay fingerprint triggers the existing
   rebuild/capture/restore path. **3. Repair/rebuild current game** also creates a
   `pre-repair` backup before a forced rebuild.
4. Check the revision, clean startup, save CRC acceptance, and human/bot progress.
   Keep checksum validation enabled; do not change save versions or reset SQLite.

For offline ZIP updates, preserve the complete `userdata/` and a separate offline
backup before replacing application files. Import/replace bundled Progressive
(menu 6) uses the existing import flow; do not import another revision over 254.

## Focused verification

Tests require an **assembled** Progressive r254 engine (compact-store base plus
bundled overlay), existing dependencies, and generated r254 packs. From its engine
directory:

```sh
ENGINE_REVISION=254 BUILD_SRC_DIR=../content BUILD_VERIFY=true BUILD_VERIFY_FOLDER=true BUILD_VERIFY_PACK=true node --import tsx tools/pack/Build.ts
node --import tsx --test tests/player-save.test.ts tests/persistence-runtime.test.ts
```

Tests use temporary save directories and a fresh SQLite DB from the existing
migrations, never an operator's characters. They cover interrupted/failed writes,
CRC rejection, per-character ordering, central logout failure and DB completion,
retention of failed snapshots after reconnect, and cancellation permissions.
The restart fixture boots the real world/map, admits a network-player character
using an in-memory transport and the configured BotManager population, advances
XP/inventory/bank/permanent variables/playtime, sends SIGTERM, and waits for actual
process exit after logout acknowledgements. A fresh process reloads the human
and bots and checks saved progression and CRCs. An injected first logout failure
also verifies retention and retry before shutdown completion. This is a server
persistence test; it does not automate clicking through the native client UI.
