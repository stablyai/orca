// Probes a running daemon's loaded modules (via loaded-modules.ps1) and flags
// any that resolve under the original app dir — those would be locked during an
// NSIS update and defeat the relocation.

import { spawnSync } from 'node:child_process'
import { join, win32 } from 'node:path'

const HERE = import.meta.dirname
const POWERSHELL = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

// Case-insensitive, separator-normalized containment test. The inputs are always
// Windows module paths, so use win32 semantics explicitly — otherwise --selftest
// on a non-Windows host would treat `\` as a literal and every check would fail.
function normalizeForCompare(p) {
  return win32
    .normalize(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/**
 * Pure filter: which of `modulePaths` live under `appDir`. Exported so selftest
 * can validate the containment logic against synthetic inputs without a launch.
 * Matches on a path-segment boundary so `C:\App` does not match `C:\Application`.
 */
export function findAppDirResidentModules(modulePaths, appDir) {
  const needle = normalizeForCompare(appDir)
  const prefix = `${needle}${win32.sep}`
  return modulePaths.filter((raw) => {
    const candidate = normalizeForCompare(raw)
    return candidate === needle || candidate.startsWith(prefix)
  })
}

/**
 * Run the PowerShell probe for `pid`. Returns
 * { found, mainModule, modules } or throws if PowerShell itself fails.
 */
export function probeLoadedModules(pid) {
  const script = join(HERE, 'loaded-modules.ps1')
  const result = spawnSync(POWERSHELL, [...PS_ARGS, '-File', script, '-ProcessId', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.error) {
    throw new Error(`failed to spawn PowerShell probe: ${result.error.message}`)
  }
  // Check exit status before parsing: a non-zero exit that still wrote to stdout
  // would otherwise surface as a bare JSON SyntaxError instead of the real error.
  if (result.status !== 0) {
    throw new Error(`loaded-modules.ps1 exited with status ${result.status}: ${result.stderr}`)
  }
  const trimmed = (result.stdout ?? '').trim()
  if (!trimmed) {
    throw new Error(
      `loaded-modules.ps1 produced no output (exit ${result.status}): ${result.stderr}`
    )
  }
  return JSON.parse(trimmed)
}

/**
 * Full handle assessment for a running daemon: whether its main module is the
 * copied host exe, and which loaded modules (if any) still live in the app dir.
 * Returns a structured verdict; never throws for a clean/empty module list.
 */
export function assessDaemonHandles(pid, appDir, expectedHostExePath) {
  const probe = probeLoadedModules(pid)
  if (!probe.found) {
    return { found: false, mainModuleOk: false, appDirModules: [], mainModule: null }
  }
  const modules = Array.isArray(probe.modules) ? probe.modules : []
  const appDirModules = findAppDirResidentModules(modules, appDir)
  const mainModuleOk =
    typeof probe.mainModule === 'string' &&
    normalizeForCompare(probe.mainModule) === normalizeForCompare(expectedHostExePath)
  return {
    found: true,
    mainModule: probe.mainModule,
    mainModuleOk,
    moduleCount: modules.length,
    appDirModules
  }
}
