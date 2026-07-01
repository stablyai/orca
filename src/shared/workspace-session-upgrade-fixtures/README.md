# Workspace Session Upgrade Fixtures

This directory holds minimized, text-only persisted session fixtures for `startup-upgrade.persisted-session-corpus`.

## `orca-1.4.65-legacy-pty-wake.json`

- Provenance: representative production `orca-data.json.workspaceSession` shape from the 1.4.65 upgrade window that motivated issue #5356 and PRs #5234/#5240.
- Scope: minimized and anonymized by hand to keep only fields the restore path consumes.
- Compatibility target: sessions written before `sleepingAgentSessionsByPaneKey` existed, while terminal tabs still carried legacy tab-level PTY wake hints.
- Startup/perf note: the gate reads one small JSON file in a focused Vitest process; it does not introduce any startup migration scan, Electron user-data copy, or binary fixture overhead.

The fixture intentionally omits `sleepingAgentSessionsByPaneKey`. Current code must still preserve the old terminal/session evidence instead of replacing the session with blank tabs.
