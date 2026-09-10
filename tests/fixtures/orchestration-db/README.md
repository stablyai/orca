# Shipped-schema orchestration DB fixtures

Real SQLite files written by real release tags, opened by
`src/main/runtime/orchestration/db/shipped-schema-fixtures.test.ts` with current code.

## Why these exist

`src/main/runtime/orchestration/orchestration-all-start-versions-migration.test.ts` builds the
**current** schema, rewrites `user_version` backwards, and reopens. A migration that forgets its
`ALTER TABLE` passes there, because the column was already present before the stamp was moved. So
does every hand-written old-schema test, which only fabricates the tables and columns its own case
cares about. These fixtures were produced by running **each tag's own `OrchestrationDb`**, so a
column a migration forgets is genuinely absent and the open fails.

Two proofs that this is not redundant, both run against the whole
`src/main/runtime/orchestration` layer:

- Adding a column to `create-core-tables-sql.ts` with no migration turns all eight fixture cases
  red and leaves the other 924 passing tests — including the all-start-versions test — green.
- Changing `migrateV39`'s guard from `current >= 39` to `current >= 25`, a bug that only shows on
  the incremental start path, turns exactly the three old `no-unbound-mail` fixtures red and leaves
  929 tests green, including all four `unbound-mail` fixtures.

## Two variants per tag

The same release wrote two on-disk states that migrate down **different paths**, so each tag has
two files.

| Variant | File | What it holds | Start version current code resolves |
| --- | --- | --- | --- |
| `unbound-mail` | `<tag>.sqlite` | includes a direct message sent between two plain terminals with no Run | 6 at v1.4.180/190/198 — the mail sits under `run_legacy_local`, so the skew probe distrusts the stamp and replays the whole chain |
| `no-unbound-mail` | `<tag>-no-unbound-mail.sqlite` | the same database without that message | the stored stamp (25 / 29 / 30 / 40) — only the tail migrations run |

The second variant is the path most upgrading users are actually on, and it is the only one that
can catch a migration whose guard is right when replayed from the bottom and wrong when entered at
the stored version.

## The fixtures are immutable

A fixture is a record of what a release really wrote to disk. Regenerating one changes what "the
shipped state" means, so it needs review like any behaviour change, and `manifest.json` pins each
file's sha256 so an accidental rewrite fails the test. Add a tag; do not refresh a tag.

## How they were produced

`node tests/fixtures/orchestration-db/generate-fixtures.mjs [tag...]`

For each tag the generator:

1. `git worktree add --detach $TMPDIR/orca-fixture-<tag> <tag>` (a new throwaway worktree; it never
   touches an existing one) and symlinks the current `node_modules` into it. Every tag below uses
   `node:sqlite` through `src/main/sqlite/sync-database.ts`, so there is no native module to
   rebuild — a tag that predates that would need its own install.
2. Bundles `populate-fixture.mjs` with esbuild **against that worktree's TypeScript**, so
   `OrchestrationDb` is the tag's own code, then runs it once per variant.
3. `PRAGMA wal_checkpoint(TRUNCATE)` + `VACUUM`, closes (which removes the `-wal`/`-shm` sidecars),
   copies each file next to this README, records the observed rows in `manifest.json`, and removes
   the worktree.

`populate-fixture.mjs` calls, in order:

| Call | Arguments | Variant |
| --- | --- | --- |
| `createRun` | objective `Shipped-schema fixture run`, coordinator `coordinator-alpha` on pane `tab-coordinator:1111…` | both |
| `createTask` | spec `Shipped-schema fixture task`, `runId` = the new Run | both |
| `createDispatchContext` | task above, assignee `worker-beta` on pane `tab-worker:2222…` | both |
| `insertMessage` | id `msg_fixture_direct`, `terminal-gamma` → `terminal-delta`, **no `runId`** | `unbound-mail` only |
| `insertMessage` | id `msg_fixture_run_mailbox`, `worker-beta` → `run:<id>`, `runId` = the Run | both |
| `createRemoteDispatchAttachment` | dispatch `ctx_federated_fixture`, task `task_federated_fixture`, home peer `home-peer-fixture` | both |

Three call shapes changed across these tags, so the generator holds them as data in `TAGS` and
`VARIANTS`:

- `dispatchArguments`: v1.4.180 and v1.4.190 take `createDispatchContext(taskId, handle, paneKey)`;
  v1.4.198 and v1.4.199 take a params object with `creator` and `maxDepth`.
- `attachmentCarriesRunId`: only v1.4.199 accepts `runId` on an attachment. That is the point of
  the v40 migration, which mints a stub home Run for the older shape.
- `includeUnboundDirectMail`: the variant switch above.

The populate asserts what it wrote (dispatch bound to `worker-beta`, all messages unread, the
direct mail not rerouted), so a wrong shape entry fails the generator instead of silently writing a
different fixture.

## What is in each file

| Tag | Commit | `user_version` | Direct mail lands under | Attachment `run_id` on the wire |
| --- | --- | --- | --- | --- |
| v1.4.180 | `0b62333cf1` | 25 | `run_legacy_local` | absent |
| v1.4.190 | `6e4f817101` | 29 | `run_legacy_local` | absent |
| v1.4.198 | `a2b1751aa2` | 30 | `run_legacy_local` | absent |
| v1.4.199 | `28957d6004` | 40 | `run_unbound` | present |

Row counts (tables not listed are empty; see `manifest.json` for the full per-table counts):

| File | `runs` | `messages` | `tasks` | `dispatch_contexts` | `mutation_receipts` | `remote_dispatch_attachments` | `run_coordinator_handles` | `mutation_receipt_ledger` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `v1.4.180.sqlite` | 2 | 2 | 1 | 1 | 1 | 1 | — | — |
| `v1.4.180-no-unbound-mail.sqlite` | 2 | 1 | 1 | 1 | 1 | 1 | — | — |
| `v1.4.190.sqlite` | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 |
| `v1.4.190-no-unbound-mail.sqlite` | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| `v1.4.198.sqlite` | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 |
| `v1.4.198-no-unbound-mail.sqlite` | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| `v1.4.199.sqlite` | 3 | 2 | 1 | 1 | 1 | 1 | 1 | 1 |
| `v1.4.199-no-unbound-mail.sqlite` | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

`run_coordinator_handles` and `mutation_receipt_ledger` postdate v1.4.180, which is why that tag has
no row for them. `runs` is 2 rather than 1 everywhere because the v7 migration seeds
`run_legacy_local` in every database, including a brand new one; `v1.4.199.sqlite` has a third
because `insertMessage` with no `runId` mints `run_unbound` on first use.

### The federated attachment is present at all four tags

The PR brief assumed federation shipped in v1.4.198. It did not:
`orchestration.federationAttachStart` and `remote_dispatch_attachments` are present at v1.4.180
already (`src/main/runtime/rpc/methods/orchestration-federation.ts:54` at that tag), while the
federation revival PR #16904 is **not** an ancestor of v1.4.198. So an attachment row is a state
each of these releases could really write, and every fixture has one.

## What current code does to each fixture on first open

This is asserted by the test, not just documented here.

- **Every `no-unbound-mail` fixture, and `v1.4.199.sqlite`**: the resolved start version is the
  stored stamp. At v1.4.199 that is 40 and nothing runs at all; at 25/29/30 only the tail
  migrations run. No `legacy_adoptions` row is created and no message `run_id` moves.
- **`v1.4.180.sqlite` / `v1.4.190.sqlite` / `v1.4.198.sqlite`**: the direct mail sits at
  `run_legacy_local`, so `hasConsistentLegacyAdoption` (`orchestration-schema-version-skew.ts`)
  reports an inconsistent legacy graph and `resolveOrchestrationMigrationStartVersion` returns
  **6**, not the stored version. The whole chain replays and:
  - `adoptLegacyRunIfNeeded` (the v19 step) inserts **one** `legacy_adoptions` row and **rewrites
    `msg_fixture_direct.run_id`** from `run_legacy_local` to the newly minted adopted Run. This is
    the documented intent of that migration, not a defect: `read` stays 0 and `to_handle` stays
    `terminal-delta`, so `check` for that terminal still returns the mail. The test asserts the new
    value by reading `legacy_adoptions`, because the adopted id is minted at migration time.
  - `migrateV40` adds `remote_dispatch_attachments.home_run_id` and backfills it to
    `run_federated_ctx_federated_fixture`, minting that stub Run.
  - `runs` therefore goes from 2 to 4.
- On the **second** open of the same file every fixture is inert: the resolved start version is 40,
  and `sqlite_master` plus every table's row count are byte-identical to the first open.

## Size

Each file is 328–436 KB after `VACUUM`, almost all of it empty pages for ~24 tables and their
indexes at SQLite's default 4 KB page size; 3.1 MB for all eight. They are stored at the real page
size on purpose; shrinking them would mean writing a fixture no release would have written.
