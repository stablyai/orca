// NSIS /D isolates files but still overwrites real HKCU install/uninstall keys and Start Menu/Desktop shortcuts.
// Snapshot/restore shared state around every isolated run so later real updates cannot target the test directory.
// Use reg.exe export/import/delete and read-only PowerShell discovery.

import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCommandSync } from './powershell-runner.mjs'

const UNINSTALL_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const APP_ROOT = 'HKCU\\Software'

// Discover uninstall key by DisplayName/GUID and install key by ShortcutName/InstallLocation; return concrete keys/location or null.
export function discoverInstallRegistryState() {
  const ps = [
    `$un = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'`,
    `$uninstallName = $null; $displayName = $null; $displayVersion = $null`,
    `foreach ($k in @(Get-ChildItem $un -ErrorAction SilentlyContinue)) {`,
    `  $dn = $k.GetValue('DisplayName'); $il = $k.GetValue('InstallLocation')`,
    `  if ($dn -eq 'Orca' -or ($il -and $il -match '\\\\Programs\\\\orca')) {`,
    `    $uninstallName = $k.PSChildName; $displayName = $dn; $displayVersion = $k.GetValue('DisplayVersion')`,
    `  }`,
    `}`,
    `$appName = $null; $installLocation = $null`,
    `foreach ($k in @(Get-ChildItem 'HKCU:\\Software' -ErrorAction SilentlyContinue)) {`,
    `  $il = $k.GetValue('InstallLocation'); $sn = $k.GetValue('ShortcutName')`,
    `  if ($il -and ($sn -eq 'Orca' -or $il -match 'orca')) {`,
    `    $appName = $k.PSChildName; $installLocation = $il`,
    `  }`,
    `}`,
    `ConvertTo-Json -Compress -InputObject @{ uninstallName = $uninstallName; appName = $appName; installLocation = $installLocation; displayName = $displayName; displayVersion = $displayVersion }`
  ].join('\n')
  const { stdout } = runCommandSync(ps)
  let parsed = {}
  try {
    parsed = JSON.parse(stdout.trim() || '{}')
  } catch {
    parsed = {}
  }
  return {
    uninstallKey: parsed.uninstallName ? `${UNINSTALL_ROOT}\\${parsed.uninstallName}` : null,
    appKey: parsed.appName ? `${APP_ROOT}\\${parsed.appName}` : null,
    installLocation: parsed.installLocation || null,
    displayName: parsed.displayName || null,
    displayVersion: parsed.displayVersion || null
  }
}

/** The two directories NSIS writes Orca shortcuts into: Start Menu + Desktop. */
export function shortcutDirs() {
  const appData =
    process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')
  const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  return [startMenu, resolveDesktopDir()]
}

function resolveDesktopDir() {
  // Resolve Desktop through shell API because OneDrive can redirect it.
  const { stdout } = runCommandSync(`[Environment]::GetFolderPath('Desktop')`)
  const line = stdout.trim()
  if (line && existsSync(line)) {
    return line
  }
  return path.join(process.env.USERPROFILE ?? '', 'Desktop')
}

/** Read-only: list Orca *.lnk shortcuts under the given dirs (recursive). */
export function discoverOrcaShortcuts(dirs = shortcutDirs()) {
  const found = []
  for (const dir of dirs) {
    collectOrcaLnks(dir, found)
  }
  return found
}

function collectOrcaLnks(dir, out) {
  if (!existsSync(dir)) {
    return
  }
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectOrcaLnks(full, out)
    } else if (entry.isFile() && /\.lnk$/i.test(entry.name) && /orca/i.test(entry.name)) {
      out.push(full)
    }
  }
}

// Before install, export existing keys/copy shortcuts and record a manifest so restore distinguishes originals from test-created state.
export function backupInstallState(runDir) {
  const backupDir = path.join(runDir, 'install-state-backup')
  mkdirSync(backupDir, { recursive: true })
  const state = discoverInstallRegistryState()
  const dirs = shortcutDirs()
  const manifest = {
    backupDir,
    shortcutDirs: dirs,
    installLocation: state.installLocation,
    uninstall: null,
    app: null,
    shortcuts: []
  }
  if (state.uninstallKey) {
    const regFile = path.join(backupDir, 'uninstall.reg')
    if (regExport(state.uninstallKey, regFile)) {
      manifest.uninstall = { path: state.uninstallKey, regFile }
    }
  }
  if (state.appKey) {
    const regFile = path.join(backupDir, 'app.reg')
    if (regExport(state.appKey, regFile)) {
      manifest.app = { path: state.appKey, regFile }
    }
  }
  let i = 0
  for (const lnk of discoverOrcaShortcuts(dirs)) {
    const backup = path.join(backupDir, `shortcut-${i}-${path.basename(lnk)}`)
    try {
      copyFileSync(lnk, backup)
      manifest.shortcuts.push({ path: lnk, backup })
    } catch {
      manifest.shortcuts.push({ path: lnk, backup: null })
    }
    i += 1
  }
  writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

// Import original keys/copy shortcuts back, delete test-created state, then verify location.
// On mismatch, print the manifest’s exact manual reg import recovery command.
export function restoreInstallState(manifest) {
  const result = {
    imported: [],
    deleted: [],
    failures: [],
    shortcutsRestored: [],
    shortcutsDeleted: [],
    verified: false
  }
  const current = discoverInstallRegistryState()

  if (manifest.uninstall) {
    if (regImport(manifest.uninstall.regFile)) {
      result.imported.push(manifest.uninstall.path)
    } else {
      result.failures.push(`Failed to import ${manifest.uninstall.regFile}`)
    }
  } else if (current.uninstallKey) {
    if (regDelete(current.uninstallKey)) {
      result.deleted.push(current.uninstallKey)
    } else {
      result.failures.push(`Failed to delete ${current.uninstallKey}`)
    }
  }

  if (manifest.app) {
    if (regImport(manifest.app.regFile)) {
      result.imported.push(manifest.app.path)
    } else {
      result.failures.push(`Failed to import ${manifest.app.regFile}`)
    }
  } else if (current.appKey) {
    if (regDelete(current.appKey)) {
      result.deleted.push(current.appKey)
    } else {
      result.failures.push(`Failed to delete ${current.appKey}`)
    }
  }

  restoreShortcuts(manifest, result)

  const after = discoverInstallRegistryState()
  // Require every restore operation too: matching InstallLocation can hide failed import/delete of other keys.
  result.verified =
    result.failures.length === 0 &&
    normLoc(manifest.installLocation) === normLoc(after.installLocation)
  if (!result.verified) {
    printMismatchWarning(manifest, manifest.installLocation, after.installLocation)
  }
  return result
}

function restoreShortcuts(manifest, result) {
  const preExisting = new Set(manifest.shortcuts.map((s) => s.path.toLowerCase()))
  for (const s of manifest.shortcuts) {
    if (s.backup && existsSync(s.backup)) {
      try {
        copyFileSync(s.backup, s.path)
        result.shortcutsRestored.push(s.path)
      } catch {
        /* best effort — a missing dir means the shortcut target is gone anyway */
      }
    }
  }
  for (const lnk of discoverOrcaShortcuts(manifest.shortcutDirs)) {
    if (!preExisting.has(lnk.toLowerCase())) {
      try {
        rmSync(lnk, { force: true })
        result.shortcutsDeleted.push(lnk)
      } catch {
        /* best effort */
      }
    }
  }
}

function printMismatchWarning(manifest, expected, actual) {
  const bar = '!'.repeat(72)
  const importCmds = []
  if (manifest.app) {
    importCmds.push(`reg import "${manifest.app.regFile}"`)
  }
  if (manifest.uninstall) {
    importCmds.push(`reg import "${manifest.uninstall.regFile}"`)
  }
  const recovery =
    importCmds.length > 0 ? importCmds : ['(no backup was captured — no manual import available)']
  console.error(`\n${bar}`)
  console.error('!! WIN-UPDATE-E2E: REGISTRY RESTORE VERIFICATION FAILED')
  console.error(`!! Expected InstallLocation: ${expected ?? '(none / no pre-existing install)'}`)
  console.error(`!! Actual   InstallLocation: ${actual ?? '(none)'}`)
  console.error('!! Your REAL Orca install pointer may be hijacked to the test directory.')
  console.error('!! The next real Orca update could install into the test location.')
  console.error('!! Recover manually by running these command(s) in an elevated-free shell:')
  for (const cmd of recovery) {
    console.error(`!!   ${cmd}`)
  }
  console.error(`${bar}\n`)
}

function normLoc(value) {
  if (!value) {
    return ''
  }
  return value.replace(/[\\/]+$/, '').toLowerCase()
}

function regExport(keyPath, file) {
  try {
    execFileSync('reg', ['export', keyPath, file, '/y'], { stdio: 'ignore' })
    return existsSync(file)
  } catch {
    return false
  }
}

function regImport(file) {
  if (!file || !existsSync(file)) {
    return false
  }
  try {
    execFileSync('reg', ['import', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function regDelete(keyPath) {
  try {
    execFileSync('reg', ['delete', keyPath, '/f'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Standalone read-only mode: print what an isolated run would snapshot. Touches
// nothing. `node registry-shortcut-backup.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  console.log('[registry-shortcut-backup] discovered install registry state:')
  console.log(JSON.stringify(discoverInstallRegistryState(), null, 2))
  console.log('[registry-shortcut-backup] Orca shortcuts that would be backed up:')
  console.log(JSON.stringify(discoverOrcaShortcuts(), null, 2))
}
