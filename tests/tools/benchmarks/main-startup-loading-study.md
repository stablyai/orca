# Main-process startup loading study (2026-10-26)

This standalone PR adds benchmark tooling and historical experimental findings only; it contains no production runtime changes. The measured stack reduces median whole-app idle Linux PSS by **13.221 MB (3.04%)**, with a **24.85 ms median first-use SSH penalty** and a brief main-process pause. Main-only measurements show 4.44 MB less V8 heap and 5.87 MB less RSS in a separate cohort. These savings must not be added together. Native macOS physical footprint remains unverified.

## Merge disposition

- **Evidence #33912:** independent of the implementation stack, based on `main`; merge after its own required checks and aggregate PR gate pass.
- **SSH #33892:** keep draft; narrow transport/test loading and repeat the Docker latency comparison before promotion.
- **Telemetry #33896:** evaluate independently against `main`, including enabled/disabled SDK delivery, consent changes and shutdown. The historical queue is capped at 100 events and discards events if shutdown precedes transport startup; this is a telemetry-completeness tradeoff, not zero behavior change.
- **History #33894 and YAML #33895:** defer for this RAM project; neither demonstrated an individual full-idle saving.
- **RPC #33893:** hold; it increased memory in the full app.

“Candidate” below identifies the immutable historical measured stack, not a recommendation to merge its constituent PRs together. Further implementation changes require new evidence; these measurements do not apply automatically to a standalone telemetry port or a narrowed SSH loader.

## Historical comparison and method

- Base: `15a1ff75fc5db5caff151b8b90ed50700ef262ac`.
- Candidate: `e36de62ce0e` (M1, M2, M4, M5, M6 and the benchmark; runtime build `6778f87122c`).
- RPC experiment included: `49e90c468ed` (M1–M6 and the same benchmark).
- SSH/lifecycle attribution: `759b6b2cf64` (M1/M2 only). The measured candidate and RPC-inclusive trees differ only by the 14-file M3 change.
- Linux x64, Electron 43.8.1, production electron-vite bundles under the development runtime; isolated fresh HOME/profile, telemetry disabled, GPU disabled, Xvfb, one hidden renderer.
- Three fresh launches per build; sample 120 seconds after the first renderer's DOM content is loaded. Builds use the same pinned source base and dependencies. Baseline runs preceded candidate runs; they were not interleaved. Other tests were running on this host, so startup timing and small RSS differences are not causal performance evidence.
- Sample `process.memoryUsage()`, Electron process-memory information, V8 heap statistics, and the actual CJS cache. No heap snapshot or forced GC. Measurements cover the main process, not the whole process tree.
- MB means 1,000,000 bytes. Electron's reported KiB values are converted using 1,024 bytes/KiB.

| Main-process metric              | Base median | Candidate median | With M3 median |
| -------------------------------- | ----------: | ---------------: | -------------: |
| V8 heap used                     |   50.893 MB |        46.453 MB |      46.924 MB |
| V8 heap capacity                 |   53.711 MB |        48.845 MB |      49.152 MB |
| RSS (`memoryUsage`)              |  270.610 MB |       264.741 MB |     270.647 MB |
| Electron-reported private memory |  121.303 MB |       117.563 MB |     125.121 MB |
| External memory                  |   16.012 MB |        14.974 MB |      17.062 MB |
| Loaded main CJS files            |         172 |              216 |            417 |
| Bytes in loaded main CJS files   |   12.284 MB |        12.154 MB |      11.849 MB |
| Loaded dependency CJS files      |         234 |              109 |            109 |
| Loaded SSH2 files                |          21 |                0 |              0 |
| Loaded PostHog files             |          28 |                0 |              0 |
| Loaded YAML files                |          72 |               72 |             72 |

Per-run heap used (MB): base `50.877, 50.893, 50.895`; measured candidate `46.468, 46.453, 46.451`; with M3 `46.924, 46.942, 46.911`. Per-run RSS (MB): base `271.471, 267.411, 270.610`; measured candidate `264.741, 263.381, 265.314`; with M3 `270.647, 272.306, 269.730`.

M1/M2 alone produced medians of 48.183 MB heap, 265.642 MB RSS and 118.100 MB reported private memory. It loaded 215 main CJS files. The remaining candidate changes reduce heap further and remove PostHog; M4/M5 do not make xterm or YAML cold in this workload.

### Why M3 is held

Compared with the measured candidate stack, adding M3 yields 201 more loaded main CJS files, +0.471 MB median heap, +5.906 MB median RSS, +7.557 MB median reported private memory and +2.089 MB external memory. Its loaded main-file source bytes fall by only 0.305 MB. The standalone registry import graph improves, but much of that implementation code remains reachable through the runtime inheritance chain. The generated metadata and finer bundler partitioning introduce additional startup work.

The observation is sufficient to withhold this memory optimization from the measured candidate stack. It does not identify the allocator responsible for every native byte. A revised design needs a full-app win before promotion; do not infer that from its isolated source graph or cold registry test. The implementation and contract tests remain reviewable in the separate draft.

The main-file count reflects bundler partitioning, not enabled services. Fewer dependency files do not by themselves establish a native-memory win. These sequential, non-interleaved Linux runs show a modest improvement for the measured candidate workload; they do not establish the proposal’s 10–13 MB macOS footprint estimate. Packaged releases, retained profiles, native Windows/macOS execution and actual mixed-version fleets remain unmeasured here.

## Boundaries and correctness

1. **M1 / quit lifecycle:** the quit controller imports an ordered registry, and initialized owners register their existing drains. Named phase positions preserve the update veto, synchronous SSH-detach/final-save ordering, daemon disconnect versus shutdown, metadata cleanup and deadlines. A second review caught a late-first-owner shutdown regression; explicit passed-phase admission checks now reject those starts without eagerly importing owners or replaying callbacks.
2. **M2 / SSH and managed hosts:** IPC names and passive reads are available immediately. A shared retryable loader owns active transport, migration, tunnel and forward restoration. Saved managed targets still initialize before renderer/serve publication. Cleanup registers before side effects. Obsolete tunnel requests retain cancellation records only until their pending start settles, then remove them in `finally`.
3. **M3 / RPC (separate experiment, excluded):** static generated names, permissions, schema identities and streaming flags stay synchronous. Seventy implementation groups load on dispatch, with single-flight/retry behavior and cancellation checks that prevent late streaming subscriptions. Exhaustive parity covers 777 declarations and both compile switches. The standalone registry source graph shrinks from roughly 3,508 files to 486, but that does not mean those files all leave the full application graph.
4. **M4 / history:** only eligible incremental replay imports its emulator. Missing/header-only histories stay cold. Load/constructor failures preserve checkpoint fallback, and all paths release replay admission.
5. **M5 / YAML:** shared parsing/normalization is unchanged, renderer/CLI retain their ESM facade, and main uses a synchronous first-use loader. Limits and recipe contracts remain intact.
6. **M6 / telemetry:** startup capture is bounded to 100 validated events (excess events are dropped, and shutdown before transport startup discards the queue); a single transport starts after the existing first-window deferral (15-second headless fallback). Consent is checked before and after loading, disabled/unofficial sessions create no client, and shutdown prevents late construction. Explicit opt-in can start immediately.

## Runtime and contract checks

- Both Linux builds passed. The complete measured candidate `check:changed --maxWorkers=2` gate passed 23 of 24 checks: 2,119 test files passed, 3 failed and 16 were skipped; 22,643 tests passed, 3 failed, 8 were expected failures and 117 were skipped. The same three daemon initialization cases also fail in a separate full-context control at the pinned upstream base. Details follow below; the complete gate remains failing.
- M1: 18 quit/fence tests, 77 existing owner tests, and 7 independent rereview tests passed; Node typecheck and commit checks passed.
- M2: 290 focused tests passed across registration, first use/retry, partial initialization, shutdown, managed-target and forward restoration, auth, reconnect, cancellation, RPC/prechecks and linking. Node typecheck and relevant ratchets passed.
- M3: catalog verification, Node typecheck, cold-bundle zero-implementation enumeration, 70-group metadata parity, compile switches, stream cancellation, serve/remote and CLI/mobile tests passed. An individual 21-check gate passed before a final test-only import relocation. The later RPC-inclusive combined gate passed 23 of 24 checks; its unit failures exposed five incomplete runtime/SSH test mocks. After correcting those mocks in M1/M2, all eight initially failing files (122 tests) passed together on both candidates. There is no claim that the full RPC-inclusive gate passed after those corrections.
- M4/M5: existing history tests and real-emulator/load-failure controls passed; 452 YAML/Hermes/update/model tests passed (one skipped).
- M6: telemetry suites and nine transport startup/consent/queue/retry/shutdown tests passed. Independent review found no remaining blocker after the history fallback fix.
- Actual measured candidate and RPC-inclusive fresh renderer IPC: SSH2 files `0 → 21` on first `testConnection`. A synthetic refused endpoint returns `ECONNREFUSED`; a separate loopback SSH2 server authenticates and returns `status: connected`, then the probe disconnects. This proves transport loading and handshake, not real managed-server deployment, SFTP, live forwarding or production auto-reconnect.
- Actual local runtime socket (both builds): `host.platform` and `status.get` return successful replies through each build's registered RPC surface.
- Playwright CDP rendered check: initial desktop and SSH settings/add-host/test flow render successfully; the connection-refused toast is visible. All app windows remain hidden on an isolated display. No UI layout/style changed.
- Benchmark failure controls: launch rejection removes the isolated profile; process-enumeration failure still closes the owned app and removes its profile. Both controls expose the original cleanup leaks and pass against the final harness.

### Broad-suite baseline failures

Repeated measured candidate gates fail the first case in each of these unchanged test files:

- `daemon-init-provider-installation.test.ts` (Node runtime): rebind listeners after installing the first provider.
- `daemon-init-child-startup-failure.test.ts` (Bun): reject a child with changed endpoint identity.
- `daemon-init-severed-host-image.test.ts` (Bun): quarantine a busy daemon whose AppImage files are gone.

The failures call real `mkdirSync` under `/fake` or `/fake/userData/daemon` despite the fixture's filesystem mock and report `EACCES`. A separate broad `vitest related` control at base `15a1ff75fc5db5caff151b8b90ed50700ef262ac`, with the candidate's source-input list and two workers, reproduces the same three cases. Focused runs pass, including all 31 tests in these three files with the full source-input list and explicitly restricted project includes. This establishes that the observed failures predate this refactor; the broad-context mock interaction is not diagnosed or repaired here.

The original evidence branch’s production source matched the measured candidate revision; later commits corrected five runtime/SSH test mocks, hardened benchmark cleanup and documented results. This standalone extraction carries only tooling and the report onto a newer `main`. Its own checks do not validate the historical implementation stack. Historical draft CI skipped the heavy checks; local validation did not establish packaged or native Windows/macOS readiness.

## Whole-app idle memory follow-up

A separate cohort measures all owned Linux app processes, with three interleaved fresh launches per build sampled 120 seconds after renderer DOM readiness. Order is A/B, B/A, A/B, one app at a time, after the Docker latency workload has finished. Build identities match the comparison above. The workload has one hidden renderer, no repo/workspace or active terminal/agent/SSH, and disabled GPU acceleration and telemetry. No forced GC or heap snapshot is used.

| Median whole-app metric              |       Base |  Candidate |
| ------------------------------------ | ---------: | ---------: |
| PSS (proportional resident pages)    | 435.110 MB | 421.889 MB |
| USS (private resident pages)         | 311.411 MB | 298.590 MB |
| Sum of RSS (duplicates shared pages) | 853.123 MB | 840.303 MB |

The observed PSS reduction is **13.221 MB (3.04%)**. Per-pair PSS reductions are 14.140, 8.600 and 13.221 MB. Baseline PSS ranges 432.615–435.422 MB; measured candidate PSS ranges 421.282–424.016 MB. PSS apportions shared pages rather than counting them once per mapping process. This is a different metric and cohort from the earlier main-only RSS result; the savings are not added together.

All nine processes are represented in every sample: main, renderer, GPU helper, network utility, two zygotes, terminal daemon, daemon-scope watcher and crash reporter. The sampler includes descendants and uniquely owned profile arguments, verifies process start identity, and checks every Electron-reported PID is covered. There are no missing app PIDs, smaps read errors or swapped pages. Xvfb, benchmark driver and Docker are excluded. Median main PSS is 190.609 → 179.289 MB; per-role medians need not sum to the whole-app median, and differences outside main are not attributed to a specific boundary.

PSS depends on other processes sharing pages, and n=3 is a small host-local sample. This establishes an observed idle reduction for this controlled profile, with no forecast for retained workspaces, active SSH/telemetry, normal GPU-composited desktop use, native Windows or macOS physical footprint. Further feature boundaries have no measured additional saving yet.

## First SSH use: measured latency tradeoff

A follow-up compares ten interleaved fresh launches per build against the repository's Docker OpenSSH fixture, with generated key authentication and actual renderer `ssh.testConnection` IPC. All 80 cold/warm authentication probes succeed and disconnect. Source/build identities match the comparison above; Electron 43.8.1, Linux x64, GPU/telemetry disabled, hidden isolated Xvfb. Requests begin 3.5 seconds after DOM readiness. Process/module caches are cold; the OS file cache is uncontrolled and was not flushed.

| Median metric                                |      Base | Candidate |
| -------------------------------------------- | --------: | --------: |
| Cold authenticated request, n=10             |  213.9 ms |  240.3 ms |
| Per-cold-call maximum main event-loop delay  |   6.58 ms |  32.28 ms |
| Overlapping main IPC maximum round-trip time |   2.65 ms |   27.8 ms |
| Warm authenticated request, n=30             | 206.25 ms |  205.8 ms |

The paired cold-request penalty is a median **24.85 ms**; per-build cold request p90 is 257.8 → 282.6 ms. Warm calls are correlated within ten processes. Renderer-local five-millisecond timers continue at about 5.2 ms; this does not prove compositor frame smoothness or native input responsiveness. The main-process pause can delay unrelated main-backed actions even while the renderer continues running. An earlier independent one-pair control reached 108.5 ms main delay / 105.3 ms main IPC RTT; it did not recur in the primary series, and its cause remains unexplained.

Dynamic import shifts parse/evaluation and initialization onto the first active SSH operation. The loaded process-wide owner is then reused. Intent-based preloading can move that work earlier and retains its memory; narrowing transport/test loading could avoid demanding managed-host and compatibility owners. Neither mitigation is implemented or measured here. The evidence establishes a one-time first-use cost, rather than zero user-facing tradeoff.

A separate public `ssh.connect` attempt on both builds returns the same unsupported-host-version refusal against the bare Docker fixture. It does not establish managed deployment, durable connect or directory browsing. Native Windows/macOS, WSL, slow-disk and WAN latency remain unmeasured. Short-run memory snapshots are transient startup data, separate from the 120-second idle measurements.

## Remaining eager graph and follow-up design

`main-process-ready` still reaches `main-process-ready-runtime` → `main-process-runtime-service` → `OrcaRuntimeService`. The service is an inheritance chain, and `pty-terminal-summary` itself extends orchestration/terminal owners rather than importing only a small summary function. Those layers statically reach `headless-terminal-state`, `provider-buffer-capture`, `terminal-visible-state`, and `HeadlessEmulator`. Durable checkpoint/replay owners provide another emulator path. M4 therefore removes one edge, not the idle xterm library.

Moving the whole runtime import until ready would shift module initialization to services startup, with no demonstrated full-idle saving. The next useful boundary is composition of optional command owners behind stable contracts. M3 shows why that must remove full-app eager owners before adding a fine-grained loader manifest. For example, `integrations/linear/linear-commands` constructs `RuntimeLinearCommands` per runtime, while `runtime-linear-command-surface` imports concrete classes and walks prototypes to install its surface. A lazy command owner would need a lightweight static method contract and preserved receiver/override behavior; moving just the getter would leave the prototype-import edge. Measure full-app script/heap/native effects before expanding that refactor.

YAML remains loaded by required Hermes hook/config refresh in a fresh profile. Delaying that refresh past its correctness deadline solely to remove YAML from a sample is not justified. M5 provides a main-only loading policy, with no idle saving attributed to this workload.

Making xterm truly cold requires changing synchronous runtime terminal creation, or introducing a supported lazy composition seam. Preserve ingestion/write ordering, renderer hydration/live overlap, cancellation generations, query replies, ConPTY behavior, daemon recovery and mobile provider snapshots. This is a separate terminal-lifecycle change, disproportionate to the proposed 0.65 MB without stronger evidence.

The same feature-owner boundary can extend beyond SSH. A bounded next experiment is speech: desktop host factories eagerly import `ModelManager` and `SttService`, although their instances are already lazy. A static counterfactual removes 15 local source files by cutting those two class-import edges; that is structural evidence, with no retained-memory attribution. Larger candidates are Linear/Jira/review owners, selected structured-agent adapters at launch/resume, and browser/emulator backends. Runtime construction and desktop IPC must both stop importing each concrete owner; the prototype-walking command facade is another eager root. The renderer already lazily loads its major settings/editor/terminal surfaces, so repeating that proposal would duplicate existing work.

Preserve synchronous names, authorization, schemas, cheap status and capability answers; use existing async demand boundaries for active owners, with shared initialization and lifecycle/cancellation fencing. Measure full-app idle and after-use memory plus first-use main/IPC latency for each experiment. Main-process deferral cannot remove the Electron floor, live editor/terminal state, or active provider memory. No additional MB or overall-app percentage forecast is established by this source audit, and candidate source shares must not be added together.

## Performance audit coverage

- **Skipped work:** traced full-app and standalone registry graphs, built chunks and actual runtime caches. SSH/PostHog are cold; YAML/xterm remain live for the owners above.
- **Ownership:** quit tasks replace by phase/name; loaders are process-owned and shared; RPC caches are bounded by the fixed group manifest; telemetry owns one client and at most 100 queued captures. No per-workspace polling or service instance was added.
- **Thread/storage:** first-use compilation remains on main. Parsing and synchronous semantics are retained where required. No new subprocess or filesystem scan cadence is introduced; module load deferral is not a background-thread claim.
- **Growth/progress:** failed loaders clear their in-flight promise; caller teardown releases streaming waiters and pending tunnel cancellation records. No removed-target tombstone map persists indefinitely.
- **Host:** cross-platform/remote paths and unchanged wire contracts reviewed; Linux executed. Windows/macOS and actual mixed-version fleets are evidence gaps, not local passes.
- **Obsolete work:** deterministic tests cover quit during load, partial initialization, first owner after quit, canceled streaming admission, tunnel removal, and telemetry consent/shutdown races. Existing durable unary operations preserve their accepted-work behavior.

## Reproduction

The committed harness reproduces main-process memory and loaded-module sampling only. The whole-app PSS and Docker latency follow-ups used separate study samplers and raw artifacts; those samplers are not included in this PR. Their recorded observations and limitations above must not be treated as output from the command below.

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm build:electron-vite
DISPLAY=:96 ORCA_BACKGROUND_LAUNCH=1 node tests/tools/benchmarks/main-startup-loading-bench.mjs \
  --app-root /absolute/path/to/build --output /tmp/main-loading.json --runs 3 --idle-ms 120000
ORCA_BACKGROUND_LAUNCH=1 pnpm check:changed --maxWorkers=2
```

This harness is Linux-only: it rejects other platforms before launch because environment-only HOME isolation does not isolate native Electron home on macOS. Use an owned isolated display. Each run clears inherited Orca/E2E overrides, isolates HOME/XDG/profile directories, rejects any presented window, bounds app shutdown, captures descendants plus processes carrying the unique profile argument, and checks Linux process start identity before TERM/KILL. It waits for owned processes to exit and fails the run on survivors or incomplete enumeration before removing the profile. These harness isolation/cleanup changes do not retroactively alter the historical measurements above. Copy `out/` before changing build revisions and keep native/package dependencies matched. Use the macOS physical-footprint rig for the original footprint claim; Linux RSS must not be substituted for it.
