// Silent NSIS install / update / uninstall and installed-app discovery.
//
// Orca ships a per-user oneClick NSIS installer (electron-builder defaults:
// oneClick=true, perMachine=false) named orca-windows-setup.exe. One-click
// silent mode is `<setup.exe> /S`; the app installs under
// %LOCALAPPDATA%\Programs\<dir> and the exe is Orca.exe. The install dir casing
// is not guaranteed (observed lowercase "orca" on a dev box), so the exe is
// located by search, never by a hard-coded path.

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertWin32 } from './platform-guard.mjs'
import { runCommandSync } from './powershell-runner.mjs'

const PRODUCT_NAME = 'Orca'
const EXE_NAME = 'Orca.exe'

/** Programs root that per-user oneClick NSIS installs into. */
function programsRoot() {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  return path.join(localAppData, 'Programs')
}

/**
 * Resolve a base/update installer to a local .exe path, downloading from a
 * GitHub release tag when requested. Keeps gh usage to a single `release
 * download` call (AGENTS.md rate-limit guidance).
 */
export function resolveInstaller({ localPath, releaseTag, assetPattern }) {
  if (localPath) {
    if (!existsSync(localPath)) {
      throw new Error(`Installer not found: ${localPath}`)
    }
    return path.resolve(localPath)
  }
  if (!releaseTag) {
    throw new Error('resolveInstaller: neither localPath nor releaseTag provided')
  }
  const outDir = mkdtempSync(path.join(tmpdir(), 'orca-e2e-installer-'))
  const result = spawnSync(
    'gh',
    ['release', 'download', releaseTag, '--pattern', assetPattern, '--dir', outDir],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(
      `gh release download ${releaseTag} failed (exit ${result.status}): ${result.stderr || result.stdout}`
    )
  }
  const found = findSetupExe(outDir)
  if (!found) {
    throw new Error(`No installer matching "${assetPattern}" in downloaded release ${releaseTag}`)
  }
  return found
}

function findSetupExe(dir) {
  const { stdout } = runCommandSync(
    `Get-ChildItem -Path '${dir}' -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue | ` +
      `Select-Object -First 1 -ExpandProperty FullName`
  )
  const line = stdout.trim().split('\n')[0]?.trim()
  return line && existsSync(line) ? line : null
}

/**
 * Run an NSIS installer in one-click silent mode and wait for the installed exe
 * to appear. Returns { exePath, version }. The installer process returns before
 * copying finishes, so completion is confirmed by polling for the exe.
 *
 * When `installDir` is set (isolated-install mode), `/D=<path>` overrides the
 * install location. `/D` is special in NSIS: it must be the LAST argument and
 * cannot be quoted, so the path must be spaces-free (validated upstream) and is
 * passed as a single unquoted argv entry.
 */
export function silentInstall(setupExe, { timeoutMs = 180_000, installDir = null } = {}) {
  assertWin32('silentInstall')
  if (!existsSync(setupExe)) {
    throw new Error(`Installer not found: ${setupExe}`)
  }
  // /S is the NSIS silent switch; the electron-builder oneClick installer needs
  // no other flags for a per-user install. /D, when present, MUST be last.
  const args = ['/S']
  if (installDir) {
    args.push(`/D=${installDir}`)
  }
  const proc = spawnSync(setupExe, args, { encoding: 'utf8' })
  if (proc.error) {
    throw new Error(`Failed to launch installer ${setupExe}: ${proc.error.message}`)
  }

  // On update runs the old Orca.exe already exists, so wait for the exe whose
  // version matches this installer — not just any exe the installer hasn't yet
  // overwritten — to avoid reading the pre-update binary mid-copy.
  const targetVersion = getExeVersion(setupExe)
  const exePath = waitForInstalledExe(timeoutMs, installDir, targetVersion)
  if (!exePath && locateInstalledExe(installDir)) {
    // Version-gated wait failed but SOME exe exists — surface both versions so a
    // comparison bug reads as itself, not as "installer produced nothing".
    const found = locateInstalledExe(installDir)
    throw new Error(
      `Installed ${EXE_NAME} exists at ${found} but its version ` +
        `(${getExeVersion(found)}) never matched the installer's (${targetVersion}) within ${timeoutMs}ms`
    )
  }
  if (!exePath) {
    const where = installDir ?? programsRoot()
    throw new Error(`Installed ${EXE_NAME} did not appear under ${where} within ${timeoutMs}ms`)
  }
  return { exePath, version: getExeVersion(exePath) }
}

// ProductVersion formats differ between the two artifacts: the NSIS setup exe
// carries the full semver (e.g. "1.4.129-rc.1") while the installed app exe
// carries a 4-part numeric version (e.g. "1.4.129.0"). Compare only the numeric
// major.minor.patch prefix — strict string equality never matches across the
// two formats and made every install wait time out (runs 28898246592 and
// 28981670571). Prerelease-only differences within one X.Y.Z are invisible to
// this check; the harness's real assertions (daemon pid, session survival) do
// not rely on it.
function normalizeExeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

function waitForInstalledExe(timeoutMs, installDir = null, expectedVersion = null) {
  const deadline = Date.now() + timeoutMs
  const expected = normalizeExeVersion(expectedVersion)
  while (Date.now() < deadline) {
    const exe = locateInstalledExe(installDir)
    // An unparseable version on either side skips the gate (presence-only wait)
    // rather than spinning until timeout on a comparison that can never succeed.
    if (exe && (!expected || normalizeExeVersion(getExeVersion(exe)) === expected)) {
      return exe
    }
    sleepSync(1000)
  }
  return null
}

/**
 * Locate the installed Orca.exe. In isolated mode (`installDir` set), the exe is
 * at a known fixed path (<installDir>\Orca.exe). Otherwise it is discovered
 * under %LOCALAPPDATA%\Programs (case-tolerant — casing is not guaranteed).
 */
export function locateInstalledExe(installDir = null) {
  if (installDir) {
    const exe = path.join(installDir, EXE_NAME)
    return existsSync(exe) ? exe : null
  }
  const root = programsRoot()
  if (!existsSync(root)) {
    return null
  }
  const { stdout } = runCommandSync(
    `Get-ChildItem -Path '${root}' -Directory -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { Join-Path $_.FullName '${EXE_NAME}' } | ` +
      `Where-Object { Test-Path $_ } | Select-Object -First 1`
  )
  const line = stdout.trim().split('\n')[0]?.trim()
  return line && existsSync(line) ? line : null
}

/** Read the ProductVersion string from an exe's version resource. */
export function getExeVersion(exePath) {
  const { stdout } = runCommandSync(`(Get-Item '${exePath}').VersionInfo.ProductVersion`)
  return stdout.trim() || null
}

/**
 * Silently uninstall the test install at an EXPLICIT directory via its
 * NSIS-generated uninstaller. Best-effort: returns false if no uninstaller is
 * found rather than throwing, so teardown never masks the real assertion result.
 *
 * SAFETY: `installDir` is REQUIRED and must be the exact directory the harness
 * installed into this run — there is deliberately no scan-and-discover fallback,
 * because a `null` default once made this function locate and uninstall the
 * developer's REAL Orca. It additionally refuses to run against the default
 * per-user install location unless `allowDefaultLocation` is explicitly set (only
 * the owns-the-install non-isolated teardown may do so).
 */
export function silentUninstall(installDir, { allowDefaultLocation = false } = {}) {
  assertWin32('silentUninstall')
  if (typeof installDir !== 'string' || installDir.trim() === '') {
    throw new Error('silentUninstall requires an explicit install directory (no scan fallback)')
  }
  const resolved = path.resolve(installDir)
  if (!allowDefaultLocation && pathsEqual(resolved, path.join(programsRoot(), PRODUCT_NAME))) {
    throw new Error(
      `Refusing to uninstall the default install location "${resolved}" — this is where a ` +
        `developer's REAL Orca lives. Isolated mode must target a separate --install-dir.`
    )
  }
  const exe = path.join(resolved, EXE_NAME)
  if (!existsSync(exe)) {
    return false
  }
  const exeDir = resolved
  const uninstaller = path.join(exeDir, `Uninstall ${PRODUCT_NAME}.exe`)
  if (!existsSync(uninstaller)) {
    return false
  }
  // NSIS uninstallers must be run from a copy (they relocate themselves); _?=
  // forces synchronous, in-place uninstall so we can assert completion.
  spawnSync(uninstaller, ['/S', `_?=${exeDir}`], { encoding: 'utf8' })
  sleepSync(2000)
  return !existsSync(exe)
}

/** Case-insensitive path equality after trailing-separator normalization. */
function pathsEqual(a, b) {
  const norm = (p) =>
    path
      .resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  return norm(a) === norm(b)
}

function sleepSync(ms) {
  // Blocking sleep via Atomics keeps install polling simple and synchronous.
  const sab = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sab, 0, 0, ms)
}
