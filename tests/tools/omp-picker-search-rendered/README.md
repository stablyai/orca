# OMP picker project-name search (#14319)

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/omp-picker-search-rendered/run.mjs`.
Uses production AgentCombobox, the production catalog and canonical CSS in a hidden
Electron renderer. Rebuilds the existing background-launch harness before execution;
all windows must remain invisible and unfocused. No dependency install is needed.

The probe types `oh-my-pi`, captures the resulting OMP row over CDP, selects it,
asserts the callback receives `omp`, and checks `oh my pi` too. Reports/screenshots
are local under `.bench-fixtures/omp-picker-search-*`. Before proof uses the baseline
catalog without search aliases and `ORCA_OMP_PICKER_BASELINE=1`, expecting no match.

Available agents are supplied by the fixture. This does not exercise local/SSH/WSL
PATH detection, disabled-agent settings, terminal launch, or a full workspace form.
Search only ranks entries supplied by each caller; aliases cannot introduce an
agent absent from that list. The broader missing-agent explanation in #14319 is
separate from this reproduced project-name search defect.
