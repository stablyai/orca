# Windows process polling oracle

This physical-Windows harness injects a preload before the Electron main and relocated terminal
daemon and their worker threads load application modules. It records every successful Node
asynchronous or synchronous child-process spawn call with executable, argv, returned pid, parent pid,
timestamp, and stack. A source audit excludes native `CreateProcess` launchers from these roots. The
harness never launches PowerShell or WMI itself.

Each run has three non-overlapping stable windows. The first measures event-loop delay before spawn
instrumentation is installed. The second records every attempted child-process call, including failed
starts, as the authoritative cadence evidence. The third runs the 25ms native Toolhelp observer while
exercising the same foreground and Resource Manager paths. Every OS-visible direct child in that third
window must correlate with an exact preload spawn record; exact records without an observer match
remain valid because polling can miss short-lived children. All foreground probes must return a
nonempty identity. The report is written before a failed cross-check makes the command exit nonzero.

Build the native observer once, then keep the entire oracle byte-identical for all four runs:

```powershell
node config/scripts/build-windows-process-tree-relay-addon.mjs --arch=x64 --out=.build/windows-process-tree/x64
node tests/tools/windows-process-polling-oracle/oracle-seam.mjs
node tests/tools/windows-process-polling-oracle/run.mjs --exe C:\build\Orca.exe --output C:\evidence\baseline-open --label v1.4.190 --resource open --duration-ms 90000
```

`--duration-ms` controls the unperturbed evidence window. `--observer-duration-ms` controls the later
cross-check and defaults to the same duration. A run refuses a nonempty `--output` directory, and the
observer exclusively creates its output and readiness files, so stale artifacts can never satisfy a
new run or be appended into its report. Use a fresh directory for every binary/state combination.

Run against an installed or unpacked packaged executable. Reports hash packaged `app.asar`, the
process-table addon when present, and the materialized daemon executable, entry, and addon.

Run `closed` and `open` against v1.4.190, latest `origin/main`, the candidate, and a build with the
candidate reverted. Compare `oracleSha256` before comparing counts. The primary evidence-window gate
is zero recurring PowerShell/WMI process-table probes in either Resource Manager state; use
`observerCrossCheck` only to validate capture coverage. One-shot startup, hook lifecycle, port scan,
and stale-daemon scenarios are separate runs and must not be folded into the idle count.
