# daemon-relocation-spike

A throwaway probe that answers one empirical question for Phase 1 of the
Windows update-survival work:

> What is the **minimal set of files** that must be copied out of a packaged
> `win-unpacked` build so that a **copied `Orca.exe`** — run with
> `ELECTRON_RUN_AS_NODE=1` from a directory **outside** the install dir — can:
> (a) start the terminal daemon and signal ready over IPC,
> (b) spawn a real ConPTY `node-pty` session, write input, and read output back,
> (c) do all of that while holding **no open file handles into the app/install
> dir**, so an NSIS update could delete the original install.

## Why this matters

The daemon is `fork()`ed from the app's own Electron binary (`Orca.exe`) with
`ELECTRON_RUN_AS_NODE=1`, from the **install** directory. On a Windows update,
electron-builder's NSIS installer (a) runs `uninstallOldVersion` (deletes the
registered install's files) and (b) `CHECK_APP_RUNNING` force-closes every
process whose image path is under `$INSTDIR`. So the daemon dies and its held
file locks can break the update.

The Phase 1 fix copies the daemon's whole file closure **out** of the install
dir (into `%LOCALAPPDATA%`/userData) and forks the daemon from the **copy**, so
its image + all loaded modules live outside `$INSTDIR`. This spike measures how
small that copy can be while still working.

We keep the **Electron binary run as node** (not a stock `node.exe`): a prior
attempt (#7473, reverted) switched to stock node and caused Windows-console
flashing (stock node lacks Electron's `kHideConsoleWindows`) plus asar breakage.
This spike does **not** reintroduce stock node.

## Usage

```
# Real run (Windows, needs a packaged win-unpacked build):
node tools/daemon-relocation-spike/spike.mjs \
  --app-dir <path-to-win-unpacked> \
  --work-dir <scratch-dir> \
  [--tier full|no-gpu|minimal] \
  [--keep-work-dir]

# Offline logic validation (any OS, no build, no launch):
node tools/daemon-relocation-spike/spike.mjs --selftest
```

Exit code is `0` only when the run **PASSES**: daemon ready, PTY echo
round-trips the nonce, the daemon's main module is the copied `Orca.exe`, and
**no** loaded module resolves under `--app-dir`.

## Tiers (defined as data in `tier-file-set.mjs`)

Every tier includes the irreducible core: `Orca.exe`, `icudtl.dat`, both V8
snapshot blobs (`snapshot_blob.bin`, `v8_context_snapshot.bin`), the daemon
bundle (`out/main/daemon-entry.js` + `chunks/` + `out/package.json`), and the
whole `node-pty` package (native `conpty.node` + the sibling `conpty/` runtime
dir holding `conpty.dll` + `OpenConsole.exe`).

Tiers differ only in which top-level `*.dll` files they carry:

| Tier      | Top-level DLLs                                                    |
| --------- | ---------------------------------------------------------------- |
| `full`    | **all** top-level `*.dll`                                         |
| `no-gpu`  | all **except** GPU/render DLLs (`libEGL`, `libGLESv2`, `vk_swiftshader`, `vulkan-1`, `d3dcompiler_47`); **keeps** `ffmpeg.dll` |
| `minimal` | **none** (exe + data blobs + daemon bundle + node-pty only)      |

Trimming further is a config change (edit `TIER_DEFINITIONS` / `GPU_DLLS`), not
a code change.

## How node-pty's native + ConPTY runtime is handled

The whole `node-pty` package tree is copied, and **the entire win-unpacked
layout is mirrored verbatim** (every copy destination is relative to the
win-unpacked root, not the asar-unpacked root). This matters because node-pty is
packaged at `resources/node_modules/node-pty` — a **sibling** of
`app.asar.unpacked`, not under it (see
`config/packaged-runtime-node-modules.cjs`). Mirroring the full layout preserves
two resolutions from the relocated path:

1. **The daemon require-closure** resolves `require('node-pty')` by walking
   parent dirs up from the mirrored
   `resources/app.asar.unpacked/out/main/daemon-entry.js`, which passes through
   `resources/` and finds `resources/node_modules/node-pty` — exactly as in the
   packaged app.
2. **node-pty's own native loader** resolves `conpty.node` from `build/Release`
   (or `prebuilds/win32-<arch>`) relative to node-pty's own `__dirname`, and
   node-pty's Windows addon loads `conpty.dll` from `<dir-of-conpty.node>/conpty/`
   and spawns `OpenConsole.exe` from beside it. Copying the tree verbatim keeps
   all three side-by-side.

### `ORCA_NODE_PTY_NATIVE_DIR`

The reverted #7421 added a `node-pty` patch that reads
`ORCA_NODE_PTY_NATIVE_DIR` to override the native dir. **The current branch's
`config/patches/node-pty@1.1.0.patch` does NOT contain that override** — it was
reverted. The spike therefore relies on **layout preservation** (copying the
node-pty tree at its default relative path) rather than the env override. The
spike still *sets* `ORCA_NODE_PTY_NATIVE_DIR` to the relocated native dir so it
keeps working if pointed at a build that carries the patch, but on this branch
the var is inert.

**Implication for the real Phase 1 implementation:** if the production copy does
NOT preserve node-pty at the path its loader resolves by default (e.g. if the
daemon-entry is relocated without the sibling `node_modules/node-pty`), the impl
will need to **re-add the `ORCA_NODE_PTY_NATIVE_DIR` patch** from #7421. If it
mirrors the layout as this spike does, the patch is not strictly required —
though re-adding it is the more robust choice.

## The handshake / client

`ndjson-client.mjs` is a small standalone NDJSON client (no electron/src
imports) that mirrors `src/main/daemon/daemon-server.ts`:

1. Read the token the server writes to the token file after it begins listening.
2. Open a **control** socket, send `hello {role:'control'}`, await
   `{type:'hello', ok:true}`.
3. Open a **stream** socket with the **same** `clientId`, send
   `hello {role:'stream'}`.
4. `createOrAttach` on control, then `write` `echo SPIKE-OK-<nonce>\r\n`, and
   read `data` events on the stream socket until the nonce appears **alone at
   line start** (executed output, distinct from the echoed input line).

`PROTOCOL_VERSION` is read at runtime from `src/main/daemon/types.ts` so the
client never drifts from the daemon.

## The handle probe

`loaded-modules.ps1` (via `loaded-module-probe.mjs`) runs
`Get-Process -Id <pid>` and enumerates `.Modules[].FileName`. Any module path
under `--app-dir` is a **lock risk** (the installer cannot replace a file a live
process maps), so a passing relocation must show **zero**. It also asserts the
process's **main module** is the copied `Orca.exe`, not the install-dir one.

Loaded DLLs are the lock-critical set. Data files (`icudtl.dat`, asar) are not
memory-mapped as modules, so this probe does not enumerate them — the copy plan
handles those by construction (they are copied, so nothing opens the originals).

## What remains unverified until CI runs it

This session has **no build**, so the launch path is unproven. Verified here:
`node --check` on every `.mjs`, a green `--selftest`, and clean
`pnpm exec oxlint`. Open questions the real CI run must answer:

- Whether `TIER_MINIMAL` (no top-level DLLs) boots `Orca.exe` as node at all, or
  whether run-as-node still needs `ffmpeg.dll` / others — this is the core
  empirical result.
- Whether the daemon bundle require-closure needs any **other** unpacked
  `node_modules` beyond `node-pty` (surfaces as a ready-timeout if so).
- Whether any loaded module still resolves under `--app-dir` (the handle probe
  will name it).

## Recommendation for the likely-minimal tier

`no-gpu` is the safe minimal target to ship: run-as-node Electron does not
initialize the GPU/render stack, so `libEGL` / `libGLESv2` / `vk_swiftshader` /
`vulkan-1` / `d3dcompiler_47` are very unlikely to load, while `ffmpeg.dll` and
the ICU/snapshot data are retained because the Electron bootstrap references
them regardless of run-as-node. Run `--tier minimal` on CI first: if it PASSES,
ship minimal; if `Orca.exe` fails to boot without the non-GPU DLLs, fall back to
`no-gpu`. `full` is the always-works upper bound for comparison.
