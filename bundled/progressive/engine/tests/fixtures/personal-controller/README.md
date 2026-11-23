This is a disposable `pr7bot` character earned by native r254 gameplay in the
isolated PR #8 browser test. The full Tutorial Island sequence, including the
native spell and mainland transition, completed before native logout and a
successful ordinary re-login. No save bytes, items, XP, quest state or tutorial
variables were edited. The native `PlayerLoading.verify` CRC check passed.

The manifest preserves the observed tutorial stage history and SHA-256. The save
starts in Lumbridge (3222, 3222, floor 0), carries the native tutorial supplies and
bronze axe, and has no Woodcutting/bank progress from mainland acceptance testing.
It contains character state only; no account password or database is included.
The test creates its own disposable non-staff account in a new SQLite database.

Use only with the network-isolated acceptance harness, never a personal account
or live persistence directory. Set `PERSONAL_BOT_FIXTURE` to this save's absolute
path. Both the manifest/hash and native CRC are validated before login.

`draynor-earned.character.sav` is a later native checkpoint of the same disposable
character, after ordinary mainland travel and six verified Woodcutting rewards
(175 total Woodcutting XP including the tutorial's 25 XP). It starts in the
northwest clearing with those six logs still in inventory. No bank deposit has
been performed yet. Its native CRC was verified before ordinary login against
the published production bundle. The manifest links back to the original fixture
hash; no save bytes were edited. Use this checkpoint for the shorter acceptance
run, or the original Lumbridge fixture to include native arrival preparation.

`draynor-banked.character.sav` preserves the next earned checkpoint: 24 additional
native logs and 600 XP, with three deposits of ten logs each. The six carried logs
from the preceding checkpoint were deposited too. It has 775 total Woodcutting XP,
30 logs in the real bank and no carried logs. This fixture exercises a fresh
objective against existing bank contents, and is the default reproducible browser
acceptance starting point. Every save remains unedited; manifests retain hashes
and the original native tutorial history.
