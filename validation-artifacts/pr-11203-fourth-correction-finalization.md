# PR #11203 fourth correction/finalization

## Verdict

Ready for two fresh adversarial verifiers. Implementation commit
`8a6dc248fbb7842b9e2be8131053191a2883081d` fixes both final3 blockers while preserving the
candidate's creator-incarnation and Run-generation fences.

The final audited tip includes this report; its exact candidate and direct-child revert OIDs are
recorded in the coordinator handoff because a commit cannot contain its own object ID.

## Topology

- Requested base: `e08eba674c195596228834bf3c1ef4f94e6b118e`
- Published PR head: `502a7142852066161c84894c853d3cd2484dd639`
- Prior candidates: `26174242ac57ddca87ded591b8a62bcffd67f548` and
  `cf9929f14cf24f8ec417b392948d112e992f72d6`
- Rejected correction: `5bc3797d024e956196f77a59764297ec6a52a029`
- Rejected third correction: `00e32e680d554baa454ee500159d612985c07cda`
- Prior direct revert: `b4c43af3abc408968052fafa86c2aae801221296`
- Fourth-correction implementation: `8a6dc248fbb7842b9e2be8131053191a2883081d`

The implementation is a direct child of `00e32e680d...`; the final report commit is its direct
child. The supplied final revert is a direct child of that audited tip and restores the exact
`00e32e680d...` tree.

## Corrections

Manual `orchestration.dispatch` now persists process incarnation only from the runtime's connected,
host-scoped Dispatch authority. Pane-only compatibility metadata may still reserve a terminal, but
missing or partial authority stores no process incarnation and therefore cannot prove creator
lineage. Injected Dispatches retain their existing capability mint and now reject before mutation
unless the same authenticated pane/process tuple is available.

The automatic `Coordinator` path now requests and persists the same pane, process incarnation, and
launch-token commitment. These are the only two production callers of `createDispatchContext`;
composed `workerStart` already attaches required pane/process authority through
`prepareStartingWorkerAuthority`, and federated attachment authority remains independently fenced.

Schema v24 adds `idx_dispatch_active_assignee_handle`, a partial index over non-null assignee
handles only while status is `pending` or `dispatched`. The full handle index remains for latest
retained-history reads. The v23 creator columns/backfill and partial pane-leaf index are unchanged.
The migration is transactional, preserves populated v23 proof, and reopens idempotently.

## Authority matrix

The identical six-oracle delta was applied to the established overlays. The topology covers durable
Run ownership, missing and mismatched Runs, renderer replacement, real H-old/process-old to
H-new/process-new remint with Run A to Run B rebind, and the 100-terminal call boundary.

| Production tree | Result |
| --- | ---: |
| Base `e08eba674c` | 0/6 |
| Published `502a714285` | 0/6 |
| Prior `26174242ac` | 1/6 |
| Prior correction `cf9929f14c` | 3/6 |
| Rejected `5bc3797d02` | 5/6 |
| Rejected third correction `00e32e680d` | 6/6 |
| Prior direct revert `b4c43af3ab` | 3/6 |
| Fourth correction implementation `8a6dc248fb` | 6/6 |

The active/historical runtime publication boundary remains exactly 201/200 calls. The new manual,
automatic, unauthenticated-manual, and pane-only-automatic production oracles are 4/4 green.

## Performance and migration

Before the index, the permanent retained-history regression reproduced 300 paired creator/active
reads at 280 ms with 20,000 same-handle rows and 694 ms with 50,000. After the correction, an
independent active-Dispatch measurement completed 300 reads in 5.122 ms and 4.797 ms respectively.
The planner selects `idx_dispatch_active_assignee_handle`; retained Run reads remain bounded, and
the pane remint fallback still selects `idx_dispatch_assignee_pane_leaf`.

Permanent tests seed both 20,000 and 50,000 retained same-handle Dispatches, enforce a 200 ms bound,
and prove an active row still rejects a competing Dispatch. Populated v21 and v23 databases migrate
to v24, retain Dispatch and creator proof, create the partial indexes, and reopen at v24. The new
SQL uses SQLite partial indexes supported since 3.8.0 and adds no Git command or platform-specific
surface.

## Validation

- Focused manual/automatic, migration, planner, retention, and concurrency gate: 193 passed.
- Full runtime: 1,016 passed, 1 skipped.
- DB, migration, adoption, legacy authority, and performance: 7 files, 114 passed.
- RPC, federation, compatibility, and SSH: 5 files, 190 passed.
- Renderer lineage/projection: 4 files, 59 passed.
- Cleanup, lifecycle, race, question, worker, and retention: 8 files, 66 passed.
- Matched authority matrix: established seven-tree `0/0/1/3/5/6/3`; correction `6/6`.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed, including native/type-aware audits, 62 reliability gates, max-lines,
  bundled skills, and localization checks.
- Commit hooks: oxlint, React Doctor, and oxfmt passed.
- `git diff --check` and staged diff checks passed.

## Security, compatibility, and gaps

Missing, stale, disconnected, or partial process authority fails closed to display metadata or the
current owning Run coordinator. No filesystem, network, shell, Git, credential, process-control,
renderer mutation, provider-specific, or executable surface was added. The production authority
source already distinguishes local, WSL, and SSH host scope; folder workspaces and provider-neutral
Run IDs remain unchanged.

No headed Electron, paired desktop/headless server, live Docker SSH, physical Windows/Linux, or WSL
journey was run. Existing deterministic runtime, federation, SSH compatibility/send, folder,
renderer, adoption, cleanup, and cross-platform identity coverage is green. Remote worker-side
grouping still lacks home Task/Run projection and remains separate protocol debt.

Coordinator next action: dispatch two fresh verifiers against the exact final candidate from the
handoff. One should repeat manual/automatic creator publication plus remint/rebind and partial
identity variants; the other should rerun 20k/50k plans, v23 migration/reopen, 201/200 calls,
retention/concurrency, federation, SSH, cleanup, and security. Do not push the published PR until
both return green.
