# PR #11293 + PR #11177 semantic integration R1

## Result

- #11293 base: `a9d8be94df2b750c9d363fc8310567dd7e5504cd`
- Preserved contributor commit: `eb76873ce7b9564b248f7317924e6c49b4001b13`
  (`JeongUk Park <jeongph.dev@gmail.com>`, cherry-picked from `2cb6a50e3`)
- Integration commit: `c1b329b72f25d8701769be52d0c400c5eaf29510`
- Finalized #11177 reference: `dc2b59723dcc8cbf2cf44ebe0511323551e9d3b3`
- Upstream xterm source: `53a98a720ae4a973e384fa2440880d09537132f3`
- Published runtime/source-map version: `6.1.0-beta.287`
- Final pnpm patch hash:
  `db949d673197f31341f8cac2b25acff4cf6073725bfb6c6d3ca2ed02cfd5c898`

The integration retains #11293/#11011's transaction IDs, pending-composition record,
tracked timers, input/blur/disposal ownership, stale-end rejection, and
Japanese/Chinese/Korean reconciliation. It layers #11177's Korean won/backtick native
forwarding, compatible optional helper interface, accepted/settled events, immediate
restart balance, runtime version, and complete generated artifact set.

Immediate restart cancels the superseded finalizer timer and settles its lifecycle before
the new transaction is accepted, while retaining the stronger pending byte record until
the restarted composition supplies authoritative text. This preserves both
`accepted, settled, accepted, settled` and Korean final-consonant transfer (`아아`, not
`앙아`). When a browser/test double omits `CompositionEvent.data`, the fallback uses
#11177's shortest ordered keypress merge; data-bearing Chromium/IBus paths retain
#11293's distinct-following-keypress contract.

## Authorship and history

JeongUk Park's original contributor authorship is preserved in its own commit before the
integration fix. The exact #11293 base remains intact, including its existing
AmethystLiang and nwparker-authored history. No commit was squashed or rewritten.

## Red control

The final 16-test CJS/ESM transaction suite was run against exact round-six parent
`be7b9b85574266d2da114e3171020db645262bc1`.

- Result: 2 failed, 14 passed.
- Both failures were the intended immediate-full-restart controls.
- Parent events were `accepted, accepted`; the candidate reports
  `accepted, settled, accepted`.

The candidate passes all 16 tests and produces `한글` exactly once.

## IME and terminal validation

| Gate                                            | Result                        |
| ----------------------------------------------- | ----------------------------- |
| Exact #11011 composition suite from `a76760649` | 42/42 passed                  |
| Exact #11177 ten-file matrix from `dc2b59723`   | 127/127 passed                |
| Combined current IME superset                   | 13 files, 218/218 passed      |
| Focused transaction/won/#11293 suite            | 4 files, 75/75 passed         |
| Broad terminal-pane suite                       | 200 files, 2,673/2,673 passed |
| Native IBus workflow contract tests             | 4/4 passed                    |

The native Linux IBus harness was not run because the integration host is macOS
(`Darwin`); the harness requires Linux/X11 and running it here would violate the
no-GUI/no-input-source-change constraint.

## Artifact and supply-chain integrity

A clean checkout of upstream xterm `53a98a7` received the publication substitutions and
the semantic source union. Upstream `tsgo -b ./tsconfig.all.json`, webpack CJS, and
production esbuild ESM builds passed. A fixture-local self-package link prevented Orca's
ancestor `node_modules` typings from contaminating the clean upstream compile.

| Artifact            | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `lib/xterm.js`      | `81b4efd747ab4188635955ef60dcc02a4c4920039fad4c9b898ff93710ff8b3a` |
| `lib/xterm.mjs`     | `13afb1a5bb49e2bbc8ff8b2867b71b0c8e61f6fb25f49af69ac8f25b72ccf24f` |
| `lib/xterm.js.map`  | `2f4394dbed6e3a5baeab2b7fb24ce6e5f940ebbab728d30c093ff8fa0f8ebb4d` |
| `lib/xterm.mjs.map` | `4d7b8a4775bca851c4c19aac70543b2881dad7af27e4f5397403ddb59ec3f090` |

- The final patch applies cleanly to the pristine npm package.
- All patched package files match the installed pnpm package byte-for-byte.
- All 24 lockfile references use the raw patch SHA-256.
- Frozen and frozen-offline installs passed, including native dependency validation.
- CJS and ESM DCS probes both report `xterm.js(6.1.0-beta.287)`.
- Both maps contain the matching `src/common/Version.ts` source.

## Repository gates

- Node, CLI, and web typechecks: passed.
- Full repository lint: passed, including type-aware/native code-quality, reliability,
  max-lines, localization, and bundled-skill gates.
- Changed-code-quality and React Doctor: 0 new findings.
- Changed TypeScript formatting: passed.
- Electron Vite production build: passed with existing chunking/CSS warnings.
- `git diff --check`: passed.

One lint invocation intentionally overlapped the Electron build and observed the build's
ephemeral `electron.vite.config.*.mjs` disappear during scanning. The standalone final
lint rerun passed; this was concurrent command interference, not a source failure.

## Latest main compatibility

- Fetched `origin/main`: `a7c8b8e07161ec05c44dbf2a0d11dad9c71a4710`
- Conflict-free merge tree: `95f1aa9fa14d3664adb9aa20a3c35f0ee481979d`
- Materialized merge frozen-offline install: passed.
- Materialized merge IME superset: 13 files, 218/218 passed.
- Materialized merge Node/CLI/web typechecks: passed.

## Security, performance, platform, and workspace audit

- No dependency version or dependency graph changed; `pnpm-lock.yaml` changes only the
  xterm patch hash references.
- No filesystem, shell, Git, provider, credential, IPC, HTML injection, or network
  surface changed.
- No unbounded timer or collection was added. Superseded finalizers are canceled and
  removed from the tracked timer set; the large-observation performance guard remains
  green.
- macOS won/backtick routing remains behind the existing input-source feature gate.
  Linux and Windows retain their existing paths, including Windows IME ownership tests.
- Forwarded native text still enters `terminal.input()` and xterm's existing ordered
  `onData` transport. Local PTYs, SSH/remote runtimes, git worktrees, and folder
  workspaces therefore share the established transport with no host-local assumption.
- No Git command, provider-specific review behavior, path handling, or native module
  baseline changed.

No push, merge, GitHub/Slack comment, reaction, GUI automation, window focus, or system
input-source change was performed.
