import { mkdirSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RESTRICTED_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'CODEX_HOME',
  'ORCA_CODEX_HOME',
  'ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME',
  'ORCA_E2E_USER_DATA_DIR',
  'ORCA_E2E_HOME_DIR',
  'ZDOTDIR',
  'ORCA_ORIG_ZDOTDIR',
  'BASH_ENV',
  'ENV'
])

type ElectronHomeIsolationOptions = {
  inheritedEnv: NodeJS.ProcessEnv
  launchEnv: NodeJS.ProcessEnv
  extraEnv: Record<string, string>
  userDataDir: string
  codexRealHomeEnabled: boolean
  realHome?: string
}

export type ElectronHomeIsolation = {
  env: NodeJS.ProcessEnv
  isolatedHome: string
  realHome: string
}

function normalizeComparablePath(candidatePath: string, platform = process.platform): string {
  const normalized = path.resolve(candidatePath)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function areSameHomePath(left: string, right: string, platform = process.platform): boolean {
  return normalizeComparablePath(left, platform) === normalizeComparablePath(right, platform)
}

function assertOverlayDoesNotReplaceIsolation(
  overlay: NodeJS.ProcessEnv | Record<string, string>,
  overlayName: string
): void {
  const restrictedKey = Object.keys(overlay).find((key) =>
    RESTRICTED_ENV_KEYS.has(key.toUpperCase())
  )
  if (restrictedKey) {
    throw new Error(
      `${overlayName}.${restrictedKey} cannot override the E2E home boundary; use codexRealHomeEnabled for sandboxed real-home coverage`
    )
  }
}

function stripAmbientHomeAndCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !RESTRICTED_ENV_KEYS.has(key.toUpperCase()))
  )
}

export function createElectronHomeIsolation({
  inheritedEnv,
  launchEnv,
  extraEnv,
  userDataDir,
  codexRealHomeEnabled,
  realHome = os.homedir()
}: ElectronHomeIsolationOptions): ElectronHomeIsolation {
  assertOverlayDoesNotReplaceIsolation(launchEnv, 'launchEnv')
  assertOverlayDoesNotReplaceIsolation(extraEnv, 'orcaAppExtraEnv')

  const requestedIsolatedHome = path.join(userDataDir, 'home')
  mkdirSync(requestedIsolatedHome, { recursive: true, mode: 0o700 })
  // Why: tmpdir-rooted paths are aliases (macOS /var symlink, Windows 8.3
  // short names). Git canonicalizes worktree paths, so a non-canonical HOME
  // makes freshly created worktrees invisible to Orca's listing comparisons.
  const isolatedHome = realpathSync.native(requestedIsolatedHome)
  // Why: a bad fixture path must fail before Electron can resolve a real Codex
  // home; userData isolation alone does not change app.getPath('home').
  if (areSameHomePath(isolatedHome, realHome)) {
    throw new Error('Refusing to launch E2E with the developer home as its isolated HOME')
  }

  return {
    isolatedHome,
    realHome,
    env: {
      ...stripAmbientHomeAndCodexEnv(inheritedEnv),
      ...launchEnv,
      ...extraEnv,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      ORCA_E2E_USER_DATA_DIR: userDataDir,
      ORCA_E2E_HOME_DIR: isolatedHome,
      ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME: codexRealHomeEnabled ? '1' : '0'
    }
  }
}

export function assertElectronResolvedIsolatedHome(
  actualHome: string,
  isolation: Pick<ElectronHomeIsolation, 'isolatedHome' | 'realHome'>
): void {
  if (
    !areSameHomePath(actualHome, isolation.isolatedHome) ||
    areSameHomePath(actualHome, isolation.realHome)
  ) {
    // Why: a failed safety assertion can land in shared CI artifacts; do not
    // print a developer username or native home path while reporting it.
    throw new Error('Electron E2E HOME escaped the disposable profile boundary')
  }
}
