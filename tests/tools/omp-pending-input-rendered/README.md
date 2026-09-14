# Pending structured input rendering proof

Run from the repository root:

```sh
ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-pending-input-rendered/run.mjs
```

Renders the production desktop message list and question/approval cards in the existing hidden Electron fixture host, with production styles. Playwright clicks the actual answer controls; CDP captures screenshots. The disposable Electron profile and output live under `.bench-fixtures/omp-pending-input-*`.

The fixture supplies an active OMP-labelled turn and changes its pending interaction. It checks both question and approval states, response submission, restored activity with the original start time, and completion. Every native window must remain hidden and unfocused.

`before-*` screenshots reproduce the old presentation by omitting the new pending-input signal on the current message list; they are **not a historical app build**. `after-*` screenshots use the signal. The fixture does not launch OMP, exercise a provider transport, render mobile, or instantiate the full Orca shell. Full structured-session wiring and mobile equivalence are covered by the adjacent component tests.
