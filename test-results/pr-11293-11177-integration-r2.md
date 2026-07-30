# PR #11293 + PR #11177 semantic integration R2

## Result

- R1 product: `c1b329b72f25d8701769be52d0c400c5eaf29510`
- R1 evidence: `1d60de49452ebd7cf0b5e3255c5c48d83d96220a`
- R2 product: `2f5811d7f6e45c0da925ed4b17f68a558b974497`
- Integration base: `a9d8be94df2b750c9d363fc8310567dd7e5504cd`
- Preserved contributor commit:
  `eb76873ce7b9564b248f7317924e6c49b4001b13`
  (`JeongUk Park <jeongph.dev@gmail.com>`)
- Upstream xterm source: `53a98a720ae4a973e384fa2440880d09537132f3`
- Runtime/source-map version: `6.1.0-beta.287`
- Final xterm patch hash:
  `642f6920fa1fdcbd740542f81895b092f383e9bfa926aa3967c4197729c5e40b`

Verifier A's P2 and P3 are fixed in both installed package formats. A restarted
transaction now rejects a pre-update end that repeats the retained prior
transaction's end observation, so the delayed stale sequence emits `AB`, not
`AA`. Deferred composition-position and view work is coalesced by ownership
slot and canceled on restart, bounding the 256-transaction same-task burst at
three tracked timers instead of 769; all tracked state drains to zero.

The retained pending composition record remains separate from accepted/settled
lifecycle settlement. This preserves immediate restart balance, Korean final
consonant reconciliation, Japanese/Chinese ordering, #11052 newline ownership,
and #11177 won/backtick forwarding.

## Parent red and candidate green

The exact verifier A R1 oracle was read and retained as the control:

- R1 installed CJS/ESM oracle: 10 passed, 4 failed of 14.
- Intended failures: delayed stale end in CJS and ESM, plus the timer bound in
  CJS and ESM.
- R2 full verifier oracle: 14/14 passed.
- Tracked focused R2 regression:
  `terminal-ime-xterm-adversarial.test.ts`, 4/4 passed.
- The tracked regression SHA-256 is
  `69b48b8733b407e8cb2ddd716bbd6dbb87ec12696e950ecaf0e738b67af9512f`.

The regression uses real installed xterm DOM listeners and separately imports
the CJS and ESM bundles. It asserts exact PTY bytes, the four-timer ceiling,
timer drainage, and disposal.

## IME and terminal validation

| Gate                                      | Result                        |
| ----------------------------------------- | ----------------------------- |
| Exact #11011 historical suite             | 42/42 passed                  |
| Exact #11177 ten-file historical matrix   | 127/127 passed                |
| #11052 Enter/newline matrix               | 3 files, 49/49 passed         |
| Current combined IME matrix               | 14 files, 222/222 passed      |
| Full verifier A adversarial oracle        | 14/14 passed                  |
| Focused tracked P2/P3 CJS+ESM regressions | 4/4 passed                    |
| Broad terminal-pane suite                 | 201 files, 2,677/2,677 passed |

The combined matrix covers accepted/settled restarts, stale/duplicate ends,
Korean/Japanese/Chinese reconciliation, won/backtick forwarding, Enter and
deferred newline behavior, blur, disposal, Linux candidates, and Windows
ownership guards.

## Artifact and lock integrity

The exact upstream xterm checkout at `53a98a7` compiled with `tsgo`, webpack
CJS, and production esbuild ESM. The installed package reconstructed from the
committed pnpm patch matches the build/package fixture byte-for-byte for the
four artifacts and all modified upstream sources.

| Artifact            | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `lib/xterm.js`      | `c624587a60f1ed497255262c8d894d7e83e7345e6477be1167a0531b56aedfe8` |
| `lib/xterm.mjs`     | `53e259559fb78c996ad5d3cfd608a8e77285e3d39b4f445719ec2ce4eea1b6e0` |
| `lib/xterm.js.map`  | `ecb49132c05a0042b563b2434756a985806cb58f024ceecec698f8cec232f509` |
| `lib/xterm.mjs.map` | `5413dad5ed07bf66a8d382e0e3da1cb3b41578f34a275e1dc5e47cbc4ae0054a` |

Both maps contain the exact rebuilt `CompositionHelper.ts` sources content
with SHA-256
`6cffe8b2aeb6d8279d1315c1c26fe7f270370e66ddc5ef43faf5b73e18c337a1`.
All 24 lockfile references use the final raw patch hash. A frozen offline
install passed and selected the matching pnpm virtual-store package.

## Repository gates

- Node, CLI, and web typechecks passed.
- Full lint passed, including native and type-aware code-quality, reliability,
  max-lines ratchet, localization, and bundled-skill checks.
- Changed-code quality and React Doctor reported zero new findings.
- Changed TypeScript formatting passed.
- Clean-worktree `git diff --check` passed; the generated patch also applies
  cleanly and reconstructs exact source and artifacts.
- Electron Vite production build passed with existing chunking and CSS
  pseudo-element warnings.
- Frozen offline install and native dependency validation passed.

## Latest main compatibility

- Fetched `origin/main`:
  `238d3a1ea167396a1b38275846cea0dd5059b04a`
- Conflict-free synthetic merge tree:
  `8d3178427df19c4e3b4d96287d66a354106b1f0b`
- Materialized merge frozen-offline install: passed.
- Materialized merge IME matrix: 14 files, 222/222 passed.
- Materialized merge Node, CLI, and web typechecks: passed.

## Platform, transport, security, and performance audit

The R2 product changes only the xterm patch, its lock hash, and deterministic
tests. No Orca PTY, SSH, remote-runtime, folder-workspace, git-worktree,
filesystem, provider, IPC, credential, HTML, or network path changed.
Forwarded text still enters xterm's ordered `onData` transport for local,
remote, and SSH terminals. Linux and Windows routing remains unchanged, while
macOS won forwarding retains its existing runtime and modifier gates.

The new timer slots are constant-space and are cleared on supersession,
callback completion, and disposal. The 256-transaction burst emitted all 256
Hangul commits exactly once and drained both pending state and the timer set.
No dependency version or graph changed.

## Bounded gaps

- The host is Darwin, so the native Linux IBus harness was unavailable.
- No GUI automation, window focus, or system input-source change was used.
- No physical macOS, Linux, Windows, Japanese, Chinese, or Korean IME journey
  was run.
- No live SSH or folder-workspace native-IME journey was run; deterministic
  transport and ownership suites cover those invariant paths.

No push, merge, comment, reaction, GUI action, window focus, or input-source
mutation was performed.
