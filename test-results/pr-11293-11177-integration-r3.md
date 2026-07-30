# PR #11293 + PR #11177 semantic integration R3

## Result

- R2 evidence HEAD: `6c26dbae39d5c9bd338b6fd3c425a3545d1bf050`
- R2 product: `2f5811d7f6e45c0da925ed4b17f68a558b974497`
- R3 product: `06e3ec2db829b8b5e4cf40f0018fa896ca267c87`
- Integration base: `a9d8be94df2b750c9d363fc8310567dd7e5504cd`
- Preserved contributor commit:
  `eb76873ce7b9564b248f7317924e6c49b4001b13`
  (`JeongUk Park <jeongph.dev@gmail.com>`)
- Upstream xterm source: `53a98a720ae4a973e384fa2440880d09537132f3`
- Runtime/source-map version: `6.1.0-beta.287`
- Final xterm patch SHA-256:
  `936fabb7682c1f7d37b9c7f49f3130c4141b6c32974f202e6f03bafaa42350ba`

R3 replaces R2's data-equality stale-end heuristic with transaction-owned observable
progress. Each composition records its starting textarea value and selection. An end
belongs to the current transaction only after the transaction has visibly changed that
value or selection, an input/deferred position callback has observed that change, or its
non-empty data matches the current transaction's own non-empty `compositionupdate`.

An ambiguous end is held in one tracked, callback-owned timer slot. If native
textarea/selection progress lands later in the same task, the end is accepted and
finalized; otherwise it remains stale and the transaction waits for its true end. This
fixes all three R2 correctness failures:

- a legitimate repeated no-update `가` commit with visible `가` to `가가` progress emits
  `가가` with balanced `accepted, settled, accepted, settled`;
- a data-less stale end immediately after restart no longer consumes the new transaction,
  and its true `B` emits final `AB`;
- a stale `end('A')` after the restarted `update('B')` but before textarea mutation no
  longer emits `AA`; the true end emits final `AB`.

Immediate restart still settles the old lifecycle before accepting the new transaction,
while retained pending bytes remain available for Korean final-consonant reconciliation.
The Orca composition route does not forward provisional session-end data marked as
pending reconciliation.

## Parent red and candidate green

The complete verifier A R2 installed-bundle oracle was read and reproduced against the
R2 product:

- R2: 20 passed, 6 failed of 26.
- The six expected failures were the repeated no-update false positive, data-less stale
  end, and stale end after current update, each in installed CJS and ESM.
- Verifier A's other 20 CJS/ESM controls remained green, including the R1 stale-end
  sequence and timer-bound/race cases.

R3 validation combined verifier A's 26 tests, verifier B's repeated no-update test in CJS
and ESM, and the R1 14-test oracle:

- R3 verifier/R1 oracle matrix: 42/42 passed.
- Tracked installed CJS/ESM xterm plus Orca route regressions: 27/27 passed.
- Combined focused regression run: 55/55 passed.
- Tracked regression SHA-256:
  `ed375b0ccba820a80385ddb2c0104fb3a37dc285cadfce6f1482483d9cdef086`.

Tracked regressions cover repeated no-update commits with progress before the end and
progress later in the same task, the original data-bearing stale end, the data-less stale
end, current-update-before-textarea stale end, same-data with and without progress, the
four-timer ceiling, timer drainage, disposal, and forced canceled-callback races.

Verifier B also reported ten trailing-whitespace additions in the R2 patch. The regenerated
R3 patch removes them: `git show --check`, `git diff --check HEAD^ HEAD`, and working-tree
`git diff --check` all pass.

## IME and terminal validation

| Gate                                                  | Result                        |
| ----------------------------------------------------- | ----------------------------- |
| Exact #11011 historical suite                         | 42/42 passed                  |
| Exact #11177 ten-file historical matrix               | 127/127 passed                |
| Exact inherited #11052 Enter/newline cases            | 49/49 passed                  |
| Current #11052/route set with R3 reconciliation test  | 50/50 passed                  |
| Current combined IME matrix                           | 14 files, 233/233 passed      |
| Verifier A R2 + verifier B + R1 oracles               | 42/42 passed                  |
| Focused tracked CJS/ESM and route regressions         | 27/27 passed                  |
| Broad terminal-pane suite                             | 201 files, 2,688/2,688 passed |
| Verifier B R2 native Linux IBus shared local-PTY path | 60/60 exact sequences passed  |

The combined matrix covers accepted/settled immediate restarts, stale and duplicate ends,
Korean final-consonant transfer, Japanese/Chinese ordering, #11052 Enter/deferred newline,
#11177 won/backtick forwarding, blur, disposal, Linux candidates, Windows ownership, and
bounded timer/callback ownership.

## Artifact and lock integrity

The exact upstream xterm checkout at `53a98a7` compiled with TypeScript, webpack CJS, and
production esbuild ESM. The committed pnpm patch applies to the matching pristine package;
the reconstructed package, installed package, and synthetic-merge installed package match
byte-for-byte for all modified source and generated artifacts.

| Artifact            | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `lib/xterm.js`      | `605f406ca62d58e3bdc4367a53b338a0504ef023d4b67d9ce55a0ebe4ef6e575` |
| `lib/xterm.mjs`     | `3073b72926335549c5b8b3549da091035be489c774e08f2b71780b92a00db6dc` |
| `lib/xterm.js.map`  | `1e2492bd1fbe8147dd9b6e47c875e4b11478c9f42c5cb24b27b8bb54482d8189` |
| `lib/xterm.mjs.map` | `851ad7e138f5a73a7ae74a404269a9a5cf1fd618c7c13db856f0b345499a09bb` |

Both maps contain the exact rebuilt `CompositionHelper.ts` sources content with SHA-256
`a2d5f3252e73c8da40e2fca91281789f8cc98ae16387d679d21b93218b697b4c`.
All 24 lockfile references use the final raw patch hash. Frozen-offline installation
passed for both the R3 product and the latest-main synthetic merge.

## Repository gates

- Node, CLI, and web typechecks passed.
- Full lint passed, including native and type-aware code-quality, reliability,
  max-lines ratchet, localization, and bundled-skill checks.
- Changed-code quality, changed React Doctor, and changed React Doctor lint reported zero
  new findings.
- Changed TypeScript formatting and `git diff --check` passed.
- Electron Vite production build passed with existing chunking and CSS pseudo-element
  warnings.
- Exact package/source/artifact reconstruction and frozen-offline install passed.

The full-repository formatter check was run and reported 20 unrelated pre-existing files,
including documentation, workflows, reliability config, and renderer files untouched by
R3. No unrelated formatting was rewritten; all R3 TypeScript files pass the formatter.

## Latest main compatibility

- Fetched `origin/main`:
  `ef55429f3d2ce3fbbcc542e4dcc8a6b36e464455`
- Conflict-free synthetic merge tree:
  `5613493fa46eaedabcc86c7041bc2369a2031d38`
- Materialized merge frozen-offline install: passed.
- Materialized merge IME matrix: 14 files, 233/233 passed.
- Materialized merge Node, CLI, and web typechecks: passed.
- Materialized merge CJS, ESM, and both maps match the R3 hashes above.

## Security, performance, platform, and workspace audit

The dependency graph and versions are unchanged; `pnpm-lock.yaml` changes only the xterm
patch hash references. The production dependency audit reports no known vulnerabilities.
The all-dependency audit was also run and reported five existing development-tool
advisories: one moderate and four high, through `shadcn > postcss` and
`electron-builder > minimatch > brace-expansion`. R3 adds no package and does not alter
those dependency paths.

R3 changes no PTY, SSH, remote-runtime, folder-workspace, git-worktree, filesystem,
provider, Git command, IPC, credential, HTML, or network path. Forwarded bytes still use
xterm's ordered `onData` transport for local, SSH, and remote terminals. Linux and Windows
routing is unchanged; macOS won forwarding retains the existing runtime/modifier gates.

Deferred composition work remains constant-space: position, view, end, and finalizer work
each owns at most one tracked slot, superseded callbacks cannot clear newer slots, and all
slots are removed on callback completion, restart, cancellation, blur, or disposal. The
4,096-transaction verifier controls and tracked 256-transaction burst emit exact ordered
bytes and fully drain tracked state.

## Bounded gaps

- The host is Darwin, so the native Linux IBus harness was unavailable.
- Verifier B independently ran the exact R2 package on isolated Debian/Xvfb/IBus and
  passed 60/60 local-PTY byte sequences; R3 changes only end ownership classification and
  retains that transport path.
- No GUI automation, window focus, or system input-source change was used.
- No physical macOS, Linux, Windows, Japanese, Chinese, or Korean IME journey was run.
- No live SSH or folder-workspace native-IME journey was run; deterministic transport and
  ownership suites cover those invariant paths.
- The repository-wide formatter and dependency audit retain the unrelated baseline
  findings described above.

No push, merge, comment, reaction, GUI action, window focus, or input-source mutation was
performed.
