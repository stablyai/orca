# Packaged Windows PTY native capability smoke

This narrow harness runs the packaged `Orca.exe` with `ELECTRON_RUN_AS_NODE=1` and loads its bundled `node-pty`. Checkout Node processes provide the target/canary shell fixtures, so the smoke proves the packaged native addon without putting a GUI-subsystem Electron executable under ConPTY. A 256-bit fixture token binds the target shell, a grandchild that remains live after its intermediate launcher exits, and an unrelated canary to one unique named-pipe channel; the oracle checks the patched exports, job PIDs, exact job-handle termination, PTY/socket exit events, and canary survival.

Run it against an unpacked Windows package:

```text
pnpm run smoke:windows-pty-native-capability -- --exe=dist/win-unpacked/Orca.exe
```

The official `v1.4.158` package is the causal red artifact: it fails immediately because its
packaged `node-pty` lacks `assignCurrentProcessToJob`. Candidate green evidence comes from the
required Windows packaging job, which runs this smoke without retries. The one-shot probe flushes
its evidence and exits explicitly because direct native job termination intentionally bypasses
node-pty's ConPTY-worker disposal path; a 45-second outer ceiling reports bounded stdout, stderr,
and native-stage breadcrumbs if any boundary stops progressing.
