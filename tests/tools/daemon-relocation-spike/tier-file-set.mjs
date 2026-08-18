// Tier definitions as DATA, so trimming the copied file set is a config change
// rather than a code change. A tier resolves (given a discovered inventory) to a
// flat list of copy operations { sourcePath, destRel, kind }.

import { dirname, join, relative, sep } from 'node:path'

// GPU/render DLLs that a run-as-node Electron host plausibly never loads. The
// spike measures whether dropping them still yields a working ConPTY host.
// ffmpeg.dll is deliberately NOT here — it is kept in the no-gpu tier.
export const GPU_DLLS = new Set([
  'libegl.dll',
  'libglesv2.dll',
  'vk_swiftshader.dll',
  'vulkan-1.dll',
  'd3dcompiler_47.dll'
])

// Each tier declares which top-level DLLs to include. The exe, runtime data
// blobs, daemon bundle, and node-pty are in every tier — they are the
// irreducible core (Orca.exe needs icu + snapshots even as node; the daemon
// needs its bundle; node-pty needs its native + conpty runtime).
export const TIER_DEFINITIONS = {
  full: { label: 'TIER_FULL_RUNTIME', dlls: 'all' },
  'no-gpu': { label: 'TIER_NO_GPU_DLLS', dlls: 'non-gpu' },
  minimal: { label: 'TIER_MINIMAL', dlls: 'none' }
}

function isGpuDll(name) {
  return GPU_DLLS.has(name.toLowerCase())
}

/**
 * Which top-level DLL entries a tier keeps. Pure over the inventory's DLL list
 * so selftest can exercise it without a real build.
 */
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

/**
 * A source file/dir's path relative to the win-unpacked root, normalized to '/'.
 *
 * Why relative to the APP DIR (not the app.asar.unpacked root): node-pty is
 * packaged at resources/node_modules/node-pty (see
 * config/packaged-runtime-node-modules.cjs), a SIBLING of app.asar.unpacked.
 * The daemon resolves `require('node-pty')` by walking parent dirs up from
 * resources/app.asar.unpacked/out/main/daemon-entry.js, which passes through
 * resources/ and finds resources/node_modules/node-pty. Mirroring the full
 * win-unpacked layout verbatim is the only copy that preserves that walk.
 */
export function toPosixRelative(appDir, absPath) {
  return relative(appDir, absPath).split(sep).join('/')
}

/**
 * Build the ordered copy plan for a tier. Returns { ops, warnings } where each
 * op is { sourcePath, destRel, kind: 'file' | 'dir' }. Every destRel mirrors the
 * source's win-unpacked-relative path. Missing required inputs are surfaced as
 * warnings rather than thrown, so the report stays complete.
 */
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

  // Core: exe + runtime data blobs live next to Orca.exe in win-unpacked.
  addFile(inv.hostExe, 'Orca.exe')
  for (const entry of inv.runtimeData) {
    addFile(entry, entry.name)
  }

  // Top-level DLLs per tier.
  for (const dll of selectTierDlls(inv.topLevelDlls, tier)) {
    addFile(dll)
  }

  // Daemon bundle: the entry, its sibling chunks/, and the unpacked
  // out/package.json (CJS/ESM loader resolution). Mirror the layout verbatim.
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

  // node-pty package tree (native binding + conpty runtime), mirrored at its
  // real win-unpacked path (resources/node_modules/node-pty).
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
