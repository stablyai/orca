# Accumulated-workspace typing benchmark

Use this opt-in Electron benchmark to reproduce typing contention from background
terminal activity. The launcher sets `ORCA_BACKGROUND_LAUNCH=1`; tests never need to
reveal or activate the app window.

## Notification-transition reproduction

```sh
pnpm bench:multi-workspace-typing -- --panes 23 --load-workspaces 4 --visited-workspaces 23 --rate-kbps 1 --keys 200 --cadence-ms 250 --pty-metadata 1 --lifecycle-ms 2000 --title-change-ms 2000 --agent-rows full --instrumentation 0 --label before --grep "sustained hidden"
```

This adds 870 workspace records across 27 repositories, 1,410 terminal tabs,
2,000 unified tabs, 857 sleeping records, and 177 status rows. It also creates
23 real visited workspaces and distributes 23 streaming PTYs across the four most
recent ones. The foreground PTY receives 200 characters over roughly 50 seconds.
The report records the resulting total census, not just the added fixture counts.

The producers send OSC titles and OSC 9999 statuses through real PTYs, main's
parser, and the production IPC batching bridge. Every two seconds they alternate
between `working` and `waiting`, exercising attention/notification dispatch.
`--lifecycle-ms 0` keeps them working, providing the message/title-only control.
`--pty-metadata 0 --metadata-status 0 --metadata-titles 0` removes recurring
metadata traffic while keeping terminal output and accumulated state.

For before/after comparisons, rebuild each source revision, use identical flags
and distinct labels, and run several sequential rounds. Reverse the build order
to check host-load drift. Do not run builds or other tests during timing windows.
`SKIP_BUILD=1` is only appropriate after explicitly building that revision with
`pnpm exec electron-vite build --mode e2e`; stale output is not a source comparison.

## What the report measures

JSON files are written to `tests/tools/benchmarks/results/`. Full-window screenshots
are saved in `.tmp/typing-reproduction/`. Build artifact fingerprints accompany
the reports so reused and rebuilt output can be distinguished.

- Planned key time → actual dispatch delay: catches a stalled test driver.
- Dispatch → PTY arrival: recorded by the foreground process in a sidecar.
- PTY arrival → first xterm buffer observation: includes polling delay.
- Planned key time → buffer observation: includes both forms of delay.
- Missing, extra, duplicate, reordered, or incorrect key arrivals invalidate the run.
- Producer byte/frame counters, observed status/title receipts, listener census,
  selected state bytes, and existing terminal-delivery counters describe the load.

The stream rate is a byte budget per timer tick; metadata frames are additional.
Backpressure and timer scheduling can lower achieved throughput, so inspect the
actual byte counters. Older exploratory artifacts without `streamPacing` paced
characters and should not be compared by their nominal KB/s labels alone.

For diagnostic sampling only, append
`--cpu-profile .tmp/typing-reproduction/typing.cpuprofile` to a single scenario.
Profiled timings must remain separate from acceptance runs. The optional direct
IPC/title fixtures and build-provided instrumentation are diagnostic controls;
the command above uses neither.

## Measurement controls

`terminal-typing-measurement-control.spec.ts` injects known renderer stalls and
requires the harness to detect input and scheduled-dispatch backlog. Run it with
`ORCA_BACKGROUND_LAUNCH=1` in the environment:

```sh
ORCA_TYPING_BENCH=1 ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test tests/e2e/terminal-typing-measurement-control.spec.ts --config tests/playwright.config.ts --project electron-headless --workers=1
pnpm test tests/e2e/paced-terminal-typing.unit.test.ts tests/e2e/accumulated-workspace-state-builder.unit.test.ts tests/e2e/sustained-agent-typing-load-scripts.unit.test.ts
```

The unit controls validate character attribution, clock ordering, fixture
identities/counts, and actual generated Unicode-stream byte pacing. For a production
fix, add a deterministic operation-count test at the affected function as well;
wall-clock thresholds alone are too sensitive to the test machine.

## Limits

This is a synthetic accumulated renderer profile, not a captured user profile.
Its selected state slices total roughly 2.16 MB, not the original report's 10 MB
durable state. Extra editor tabs have no matching open-file records. It does not
model automation-history persistence, foreground agent-TUI input behavior, native
window focus, network delay, or paired-server recovery. OSC status payloads do not
carry provider-session identities, so state transitions alone do not demonstrate
recovery-record persistence. Buffer observation is not a pixel-paint measurement.

Sidebar virtualization may change mounted listener/row counts as attention state
changes; retain the census and every valid run rather than selecting the fastest
sample. Native-focus/visible-window tests require an isolated display or CI.
