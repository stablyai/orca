// Locates the daemon-host inputs inside a packaged win-unpacked build.
//
// Layout the packager produces (see config/electron-builder.config.cjs and
// config/packaged-runtime-node-modules.cjs):
//   <app-dir>/Orca.exe                         electron binary (run as node)
//   <app-dir>/icudtl.dat                       ICU data (needed even as node)
//   <app-dir>/snapshot_blob.bin                V8 snapshot
//   <app-dir>/v8_context_snapshot.bin          V8 context snapshot
//   <app-dir>/*.dll                            electron/GPU runtime DLLs
//   <app-dir>/resources/app.asar.unpacked/out/main/daemon-entry.js  (+ chunks/)
//   <app-dir>/resources/app.asar.unpacked/node_modules/node-pty/**  native + conpty

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
export const HOST_EXE = 'Orca.exe'

// Windows arch dir names node-pty prebuilds ship under; build/Release is the
// packaged rebuild location and takes precedence.
const NODE_PTY_NATIVE_CANDIDATES = ['build/Release', 'prebuilds/win32-x64', 'prebuilds/win32-arm64']

function fileEntry(dir, name) {
  const path = join(dir, name)
  if (!existsSync(path)) {
    return { name, path, exists: false, size: 0 }
  }
  return { name, path, exists: true, size: statSync(path).size }
}

function listTopLevelDlls(appDir) {
  const dlls = []
  for (const name of readdirSync(appDir)) {
    if (name.toLowerCase().endsWith('.dll')) {
      dlls.push(fileEntry(appDir, name))
    }
  }
  return dlls.sort((a, b) => a.name.localeCompare(b.name))
}

// Resolve the app.asar.unpacked root: everything the forked daemon-entry
// require-closure resolves (chunks, node-pty) lives under it, so the copied
// host must mirror it verbatim.
function resolveUnpackedRoot(appDir) {
  const candidate = join(appDir, 'resources', 'app.asar.unpacked')
  return existsSync(candidate) ? candidate : null
}

// getDaemonEntryPath() in daemon-init.ts probes daemon-entry.js at the unpacked
// root first, then out/main — mirror that resolution order here.
function resolveDaemonEntry(unpackedRoot) {
  if (!unpackedRoot) {
    return { name: 'daemon-entry.js', path: '', exists: false, size: 0, relFromUnpacked: '' }
  }
  const direct = join(unpackedRoot, 'daemon-entry.js')
  if (existsSync(direct)) {
    return { ...fileEntry(unpackedRoot, 'daemon-entry.js'), relFromUnpacked: 'daemon-entry.js' }
  }
  const nested = join('out', 'main', 'daemon-entry.js')
  const nestedPath = join(unpackedRoot, nested)
  return {
    name: 'daemon-entry.js',
    path: nestedPath,
    exists: existsSync(nestedPath),
    size: existsSync(nestedPath) ? statSync(nestedPath).size : 0,
    relFromUnpacked: nested.split('\\').join('/')
  }
}

function resolveNodePty(unpackedRoot, appDir) {
  // Prefer the unpacked-root copy (what the daemon require-closure resolves);
  // fall back to a resources-level copy some builds also stage.
  const roots = []
  if (unpackedRoot) {
    roots.push(join(unpackedRoot, 'node_modules', 'node-pty'))
  }
  roots.push(join(appDir, 'resources', 'node_modules', 'node-pty'))

  for (const dir of roots) {
    if (!existsSync(dir)) {
      continue
    }
    for (const rel of NODE_PTY_NATIVE_CANDIDATES) {
      const nativeDir = join(dir, ...rel.split('/'))
      if (existsSync(join(nativeDir, 'conpty.node'))) {
        return {
          exists: true,
          packageDir: dir,
          nativeDir,
          nativeRel: rel,
          conptyNode: fileEntry(nativeDir, 'conpty.node'),
          // node-pty's Windows addon loads conpty.dll from <native>/conpty/.
          conptyDll: fileEntry(join(nativeDir, 'conpty'), 'conpty.dll'),
          openConsole: fileEntry(join(nativeDir, 'conpty'), 'OpenConsole.exe')
        }
      }
    }
    // node-pty present but no ConPTY native found under known dirs.
    return { exists: true, packageDir: dir, nativeDir: '', nativeRel: '', conptyNode: null }
  }
  return { exists: false, packageDir: '', nativeDir: '', nativeRel: '', conptyNode: null }
}

/**
 * Discover every daemon-host input in `appDir`. Never throws for missing files;
 * each entry carries an `exists` flag so the caller can print a full report and
 * decide whether the chosen tier is buildable.
 */
export function inventoryAppDir(appDir) {
  const unpackedRoot = resolveUnpackedRoot(appDir)
  return {
    appDir,
    unpackedRoot,
    hostExe: fileEntry(appDir, HOST_EXE),
    runtimeData: RUNTIME_DATA_FILES.map((name) => fileEntry(appDir, name)),
    topLevelDlls: listTopLevelDlls(appDir),
    daemonEntry: resolveDaemonEntry(unpackedRoot),
    nodePty: resolveNodePty(unpackedRoot, appDir)
  }
}

/** Human-readable inventory dump for the run report. */
export function formatInventory(inv) {
  const lines = []
  const kib = (n) => `${(n / 1024).toFixed(1)} KiB`
  const mark = (e) => (e.exists ? 'OK ' : 'MISS')
  lines.push(`app-dir: ${inv.appDir}`)
  lines.push(`  ${mark(inv.hostExe)} ${inv.hostExe.name} (${kib(inv.hostExe.size)})`)
  for (const e of inv.runtimeData) {
    lines.push(`  ${mark(e)} ${e.name} (${kib(e.size)})`)
  }
  lines.push(`  top-level DLLs: ${inv.topLevelDlls.length}`)
  for (const e of inv.topLevelDlls) {
    lines.push(`    - ${basename(e.name)} (${kib(e.size)})`)
  }
  lines.push(
    `  ${mark(inv.daemonEntry)} daemon-entry: ${inv.daemonEntry.relFromUnpacked || '(none)'}`
  )
  const np = inv.nodePty
  lines.push(`  node-pty: ${np.exists ? np.packageDir : '(none)'}`)
  if (np.conptyNode) {
    lines.push(`    native: ${np.nativeRel} conpty.node (${kib(np.conptyNode.size)})`)
    lines.push(`    conpty.dll: ${mark(np.conptyDll)}  OpenConsole.exe: ${mark(np.openConsole)}`)
  }
  return lines.join('\n')
}
