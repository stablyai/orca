# v9 audited-workflow fixture

**Generated. Do not hand-edit.** Regenerate with:

```sh
node config/scripts/generate-audited-v9-fixture.mjs
```

## What it is

A schema-version **9** `audited-workflow.db` — the last shape before Phase 10
added the landing lane. The installer smoke copies it into an isolated
packaged-userData directory and asserts the app migrates it to **v10** with every
seeded row intact.

## Why it exists

`createAuditedWorkflowTables` builds every table at its current shape, so a
first-launch database is born at v10 and the migration is a no-op. Observing
`user_version = 10` on a fresh profile would pass even if `migrateToV10` were
deleted. Real users upgrade over an existing profile; this fixture reproduces
that.

## Provenance

The DDL is read out of the repository at commit `7aa18be23` — the last
commit before Phase 10 — so the fixture is a real v9 rather than a
reconstruction that could drift from what shipped.

## Contents

Synthetic metadata only. No real repository paths, no real SHAs, no secrets.
Every id, timestamp, and SHA is a fixed literal, so regeneration is
byte-reproducible.

| Table | Rows |
| --- | --- |
| `audited_tasks` | 3 — `committed` (with `committed_sha`), `blocked`, `landed` (with `landed_sha` NULL) |
| `audited_commit_attempts` | 1 `completed`, bound to the committed SHA |
| `audited_publish_attempts` | 1 `completed` with `pushed_sha` |
| `audited_candidates` | 1 with `store_bytes` non-NULL |
| `audited_transitions` | 5 |

`tests/fixtures/audited-workflow/v9/audited-workflow.db` is **read-only** to
consumers: the harness copies it, never opens it in place.
