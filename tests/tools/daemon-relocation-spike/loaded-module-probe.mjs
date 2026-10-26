// Flag daemon modules mapped from the original install, which would remain locked during NSIS update.

import { spawnSync } from 'node:child_process'
import { join, win32 } from 'node:path'

const HERE = import.meta.dirname
const POWERSHELL = 'powershell.exe'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

// Always use case-insensitive win32 path semantics so offline selftests handle backslashes on any OS.
function normalizeForCompare(p) {
  return win32
    .normalize(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

// Filter modules under appDir on path-segment boundaries (C:\App must not match C:\Application).
export function findAppDirResidentModules(modulePaths, appDir) {
  const needle = normalizeForCompare(appDir)
  const prefix = `${needle}${win32.sep}`
  return modulePaths.filter((raw) => {
    const candidate = normalizeForCompare(raw)
    return candidate === needle || candidate.startsWith(prefix)
  })
}

// Run the PowerShell module probe; throw on probe failure.
export function probeLoadedModules(pid) {
  const script = join(HERE, 'loaded-modules.ps1')
  const result = spawnSync(POWERSHELL, [...PS_ARGS, '-File', script, '-ProcessId', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (result.error) {
    throw new Error(`failed to spawn PowerShell probe: ${result.error.message}`)
  }
  // Check exit status before JSON so PowerShell failure cannot masquerade as SyntaxError.
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

// Report copied-exe identity and install-dir mappings; empty module lists are valid.
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
