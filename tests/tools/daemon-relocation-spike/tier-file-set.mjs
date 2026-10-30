// Declare DLL tiers as data; resolve inventory into sourcePath/destRel/kind copy operations.

import { dirname, join, relative, sep } from 'node:path'

// Experimentally omit GPU DLLs in run-as-node; keep ffmpeg.dll in the no-gpu tier.
export const GPU_DLLS = new Set([
  'libegl.dll',
  'libglesv2.dll',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'd3dcompiler_47.dll'
])

// Every tier retains exe, ICU/snapshots, daemon bundle and node-pty native/ConPTY runtime; only top-level DLL selection varies.
export const TIER_DEFINITIONS = {
  full: { label: 'TIER_FULL_RUNTIME', dlls: 'all' },
  'no-gpu': { label: 'TIER_NO_GPU_DLLS', dlls: 'non-gpu' },
  minimal: { label: 'TIER_MINIMAL', dlls: 'none' }
}

function isGpuDll(name) {
  return GPU_DLLS.has(name.toLowerCase())
}

// Select tier DLLs purely from inventory for offline selftests.
export function selectTierDlls(topLevelDlls, tier) {
  const def = TIER_DEFINITIONS[tier]
  if (!def || def.dlls === 'none') {
    return []
  }
  if (def.dlls === 'all') {
    return topLevelDlls
  }
  return topLevelDlls.filter((e) => !isGpuDll(e.name))
}

// Use win-unpacked-relative paths, not unpacked-root-relative: daemon require walks up to sibling resources/node_modules/node-pty.
// Mirror the full layout to preserve that lookup and native resolution.
export function toPosixRelative(appDir, absPath) {
  return relative(appDir, absPath).split(sep).join('/')
}

// Return ordered copy ops plus missing-input warnings rather than throw, keeping reports complete.
export function resolveTierFileSet(inv, tier) {
  const ops = []
  const warnings = []
  const appDir = inv.appDir

  const addFile = (entry, requiredLabel, optional = false) => {
    if (!entry || !entry.exists) {
      if (requiredLabel) {
        warnings.push(`missing required input: ${requiredLabel}`)
      }
      return
    }
    ops.push({
      sourcePath: entry.path,
      destRel: toPosixRelative(appDir, entry.path),
      kind: 'file',
      optional
    })
  }

  addFile(inv.hostExe, 'Orca.exe')
  for (const entry of inv.runtimeData) {
    addFile(entry, entry.name)
  }

  for (const dll of selectTierDlls(inv.topLevelDlls, tier)) {
    addFile(dll)
  }

  // Mirror daemon entry/chunks and out/package.json for CJS/ESM resolution.
  if (inv.daemonEntry.exists && inv.unpackedRoot) {
    addFile(inv.daemonEntry, 'daemon-entry.js')
    const entryDir = dirname(inv.daemonEntry.path)
    const chunksDir = join(entryDir, 'chunks')
    ops.push({
      sourcePath: chunksDir,
      destRel: toPosixRelative(appDir, chunksDir),
      kind: 'dir',
      optional: true
    })
    const pkgJson = join(inv.unpackedRoot, 'out', 'package.json')
    ops.push({
      sourcePath: pkgJson,
      destRel: toPosixRelative(appDir, pkgJson),
      kind: 'file',
      optional: true
    })
  } else {
    warnings.push('missing required input: daemon-entry.js (+ chunks)')
  }

  // Mirror node-pty at resources/node_modules/node-pty, including native/ConPTY runtime.
  if (inv.nodePty.exists && inv.nodePty.conptyNode) {
    ops.push({
      sourcePath: inv.nodePty.packageDir,
      destRel: toPosixRelative(appDir, inv.nodePty.packageDir),
      kind: 'dir'
    })
  } else {
    warnings.push('missing required input: node-pty (with conpty.node)')
  }

  return { ops, warnings, label: TIER_DEFINITIONS[tier].label }
}
