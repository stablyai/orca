# Jira board lanes reorder by drag

Run `ORCA_BACKGROUND_LAUNCH=1 node tests/tools/jira-board-column-order-rendered/run.mjs`.

Uses the production `TaskPageJiraBoard` and its lane-order storage in a hidden Electron
renderer with the canonical CSS. All windows stay invisible and unfocused. No dependency
install is needed.

The probe captures the board in the order Jira's board configuration gives, dispatches the
same `dragstart`/`dragover`/`drop` sequence a mouse drag produces to move the Done lane in
front of To Do, then captures the result and reads back the saved order. Reports and
screenshots are local under `.bench-fixtures/jira-board-column-order-*`.

Issues, project, statuses, and the user are invented; no Jira site is contacted and no real
issue data appears. Relative times are fixed strings so captures reproduce. This renders the
board only: it does not exercise Jira fetching, the status-change dialog, or an OS-level drag
session, and dispatched drag events cannot prove the native drag image or cursor.
