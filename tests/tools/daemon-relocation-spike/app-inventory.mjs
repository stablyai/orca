// Inventory win-unpacked daemon inputs: Orca.exe, ICU/V8 snapshots, DLLs, daemon-entry/chunks and packaged node-pty/ConPTY.
// See electron-builder.config.cjs and packaged-runtime-node-modules.cjs for layout.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RUNTIME_DATA_FILES = ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']
export const HOST_EXE = 'Orca.exe'

// Prefer packaged build/Release over node-pty architecture prebuild directories.
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

// Mirror unpacked require-closure paths verbatim under the copied host.
function resolveUnpackedRoot(appDir) {
  const candidate = join(appDir, 'resources', 'app.asar.unpacked')
  return existsSync(candidate) ? candidate : null
}

// Mirror getDaemonEntryPath’s unpacked-root then out/main probe order.
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
  // Prefer the require-resolved unpacked copy; some builds also stage a resources-level copy.
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

// Report every input with exists flags, including missing ones, so callers can assess each copy tier.
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
