# OMP Source Control AI settings proof

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-source-control-ui/run.mjs`.
The runner rebuilds the existing background-safe Electron fixture and the production
`CommitMessageAiPane` with its real styles. It uses disposable HOME/ZDOTDIR/userData,
never reveals a window, and closes its own app after recording evidence under
`.bench-fixtures/omp-source-control-*/`.

DOM assertions and screenshots cover:

- OMP appears in the commit-message agent menu and can be selected.
- Selecting OMP keeps CLI arguments empty so OMP uses its configured provider/model.
- An explicit `--model provider/exact-model` argument can be saved and remains in the
  input after the save completes.

The settings persistence adapter is in-memory. This is a rendered production
component check, not a full app IPC, restart-persistence, or generation test. No
generator is called or mocked. Current Source Control AI settings expose action
recipes with CLI arguments; they do not have a Discover Models button. The separate
`omp-model-discovery-policy.test.ts` and `omp-source-control-discovery.test.ts`
regressions cover real discovery-result policy and production generation selection
with cached models, including SSH host keys. The configured-default sentinel stays
out of generic terminal catalogs while generation without a model override still
uses OMP configuration.

`tests/tools/omp-source-control-runtime-smoke.mjs` separately validates argv against
the actual OMP argument parser in a read-only reference checkout. It makes no model
call and must not be described as real generated output.
