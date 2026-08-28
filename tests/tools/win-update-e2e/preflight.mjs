// Preflight safety checks and the baseline window snapshot.
//
// The harness installs, updates, and uninstalls a real app and kills processes
// it created. To avoid ever touching a user's live Orca, it REFUSES to run when
// a pre-existing Orca app process (not a daemon) is already running that it did
// not start. Existing installs and detached daemons are warned about, not
// treated as fatal (the update path is what exercises them).

import path from 'node:path'
import { assertWin32, isElevated } from './platform-guard.mjs'
import { runCommandSync } from './powershell-runner.mjs'
import { captureBaseline } from './window-watch.mjs'
import { locateInstalledExe } from './installer-steps.mjs'
import { findDaemonProcesses } from './daemon-processes.mjs'

/**
 * Find running Orca APP processes (main window process), excluding daemons.
 * The daemon runs as Orca.exe too but always carries the daemon-entry.js marker
 * on its command line, so excluding that marker isolates the actual app. The
 * ExecutablePath lets isolated mode decide whether a running app is under the
 * test dir (fatal) or is the developer's real Orca elsewhere (informational).
 */
export function findAppProcesses() {
  const command = [
    `$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'Orca.exe'" -ErrorAction SilentlyContinue |`,
    `  Where-Object { -not ($_.CommandLine -match 'daemon-entry\\.js') })`,
    `$out = @($procs | ForEach-Object {`,
    `  [pscustomobject]@{ pid = $_.ProcessId; path = $_.ExecutablePath; commandLine = $_.CommandLine } })`,
    `ConvertTo-Json -InputObject @{ processes = $out } -Depth 4 -Compress`
  ].join('\n')
  // Fail closed: this guard protects the user's real processes, so a failed
  // query must abort the run rather than look like "no Orca is running".
  const { stdout, stderr, code, error } = runCommandSync(command)
  if (error) {
    throw new Error(`Failed to query Orca app processes: ${error.message}`)
  }
  if (code !== 0) {
    throw new Error(`Failed to query Orca app processes (exit ${code}): ${stderr || stdout}`)
  }
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  try {
    const parsed = JSON.parse(trimmed)
    const arr = parsed.processes
    return Array.isArray(arr) ? arr : arr ? [arr] : []
  } catch (parseError) {
    throw new Error(
      `Orca app process query returned invalid JSON: ${parseError.message}\n` +
        `stdout:\n${trimmed}\nstderr:\n${stderr}`
    )
  }
}

/** True if `childPath` is equal to or inside `parentDir` (case-insensitive). */
function isPathUnder(childPath, parentDir) {
  const child = path
    .resolve(childPath)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
  const parent = path
    .resolve(parentDir)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
  return child === parent || child.startsWith(`${parent}\\`)
}

/**
 * Run preflight. Returns { baseline, warnings, existingInstall }. Throws if a
 * pre-existing Orca app is running (never kill a user's process) or if an Orca
 * install already exists and allowExistingInstall was not passed (the run would
 * overwrite a developer's real build). baselinePath receives the snapshot of
 * currently-visible top-level windows.
 *
 * In isolated mode (`installDir` set) both refusals become target-scoped: only a
 * running app whose exe is UNDER installDir is fatal, and only an install already
 * in installDir triggers the existing-install refusal. A real Orca running or
 * installed elsewhere is untouched by isolated mode and is merely noted.
 */
export function preflight({ baselinePath, allowExistingInstall = false, installDir = null }) {
  assertWin32('preflight')
  const warnings = []
  const isolated = Boolean(installDir)

  if (isElevated()) {
    warnings.push(
      'Running elevated. A per-user oneClick install does not need elevation; ' +
        'an elevated run can install to an unexpected profile.'
    )
  }

  const appProcesses = findAppProcesses()
  if (isolated) {
    const inTarget = appProcesses.filter((p) => p.path && isPathUnder(p.path, installDir))
    if (inTarget.length > 0) {
      const listing = inTarget.map((p) => `  pid ${p.pid}: ${p.path}`).join('\n')
      throw new Error(
        `Refusing to run: ${inTarget.length} Orca app process(es) are running from the ` +
          `isolated target dir ${installDir} that this harness did not start. Close them ` +
          `first (this harness never kills pre-existing user processes):\n${listing}`
      )
    }
    const elsewhere = appProcesses.filter((p) => !(p.path && isPathUnder(p.path, installDir)))
    if (elsewhere.length > 0) {
      warnings.push(
        `${elsewhere.length} Orca app process(es) are running from outside the isolated ` +
          `target dir (pids: ${elsewhere.map((p) => p.pid).join(', ')}). Isolated mode never ` +
          `touches them; proceeding.`
      )
    }
  } else if (appProcesses.length > 0) {
    const listing = appProcesses.map((p) => `  pid ${p.pid}: ${p.commandLine}`).join('\n')
    throw new Error(
      `Refusing to run: ${appProcesses.length} Orca app process(es) are already ` +
        `running that this harness did not start. Close them first (this harness ` +
        `never kills pre-existing user processes):\n${listing}`
    )
  }

  // Scope the existing-install check to the target dir in isolated mode; an
  // install at the default location is left untouched and does not count.
  const existingInstall = isolated ? locateInstalledExe(installDir) : locateInstalledExe()
  if (existingInstall && !allowExistingInstall) {
    throw new Error(
      isolated
        ? `Refusing to run: an install already exists in the isolated target dir ` +
            `${existingInstall}. Pass --allow-existing-install to overwrite it (isolated mode ` +
            `never touches the real install elsewhere), or point --install-dir at an empty dir.`
        : `Refusing to run: an Orca install already exists at ${existingInstall}. ` +
            `This run would silently OVERWRITE it with the --from/--to versions and ` +
            `leave the --to version installed — destroying a real Orca install on a ` +
            `developer machine. Pass --allow-existing-install to proceed anyway ` +
            `(your prior build will NOT be restored), or uninstall Orca first. Clean ` +
            `machines (CI/VM) never hit this.`
    )
  }
  if (existingInstall && !isolated) {
    warnings.push(
      `--allow-existing-install set: the existing install at ${existingInstall} will be ` +
        `overwritten and the --to version left installed; teardown will NOT uninstall it.`
    )
  } else if (existingInstall) {
    warnings.push(
      `A prior harness install exists in the target dir ${existingInstall}; it will be ` +
        `overwritten and cleaned up at teardown (isolated mode owns the test dir).`
    )
  }

  const existingDaemons = findDaemonProcesses()
  if (existingDaemons.length > 0) {
    warnings.push(
      `${existingDaemons.length} pre-existing daemon process(es) found on this machine ` +
        `(pids: ${existingDaemons.map((d) => d.pid).join(', ')}). The run uses an isolated ` +
        `userData dir, so its daemon is tracked by scope and will not collide.`
    )
  }

  const baseline = captureBaseline(baselinePath)
  return { baseline, warnings, existingInstall }
}
