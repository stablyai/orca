// Enums for the `daemon_adopted` and `daemon_pty_cwd_denied` telemetry events (#17696).
// Both exist to measure how often a macOS app runs on a daemon left behind by an earlier app
// bundle, and how often such a daemon actually spawns a terminal whose cwd it cannot read.
// Enum-only: no paths, versions, or exact counts ever reach the wire.

/** How the adopted daemon's recorded app version compares to the running app. */
export const DAEMON_ADOPTED_APP_VERSION_MATCH = ['same', 'different', 'unknown'] as const
export type DaemonAdoptedAppVersionMatch = (typeof DAEMON_ADOPTED_APP_VERSION_MATCH)[number]

/**
 * Where the binary that forked the adopted daemon lives now. `updater-cache` is the Squirrel
 * ShipIt staging area — a daemon attributed there is the reported #17696 shape.
 */
// Why both: the download lands under ~/Library/Caches/<id>.ShipIt/, but the bundle a running
// daemon was forked from gets parked under $TMPDIR/<id>.ShipIt.<rand>/ at install time.
const SHIPIT_STAGING_PATH = /\/(?:Library\/Caches\/[^/]*ShipIt|T\/[^/]*\.ShipIt\.[^/]+)\//
export const DAEMON_SPAWNER_PATH_CLASSES = [
  'applications',
  'updater-cache',
  'other',
  'missing',
  'unknown'
] as const
export type DaemonSpawnerPathClass = (typeof DAEMON_SPAWNER_PATH_CLASSES)[number]

export const DAEMON_TCC_ATTRIBUTION_VALUES = ['intact', 'at-risk', 'severed', 'unknown'] as const

/** Which macOS-protected folder class the denied cwd falls under. */
export const DAEMON_PTY_CWD_CLASSES = [
  'documents',
  'desktop',
  'downloads',
  'other-home',
  'outside-home'
] as const
export type DaemonPtyCwdClass = (typeof DAEMON_PTY_CWD_CLASSES)[number]

export function classifyDaemonSpawnerPath(
  spawnerExecPath: string | null,
  exists: (path: string) => boolean
): DaemonSpawnerPathClass {
  if (!spawnerExecPath) {
    return 'unknown'
  }
  if (!exists(spawnerExecPath)) {
    return 'missing'
  }
  if (SHIPIT_STAGING_PATH.test(spawnerExecPath)) {
    return 'updater-cache'
  }
  return /^(?:\/private)?\/Applications\//.test(spawnerExecPath) ? 'applications' : 'other'
}

export function classifyDaemonPtyCwd(cwd: string, homeDir: string): DaemonPtyCwdClass {
  const home = homeDir.replace(/\/+$/, '')
  if (!home || !(cwd === home || cwd.startsWith(`${home}/`))) {
    return 'outside-home'
  }
  const topLevel = cwd.slice(home.length + 1).split('/')[0]
  switch (topLevel) {
    case 'Documents':
      return 'documents'
    case 'Desktop':
      return 'desktop'
    case 'Downloads':
      return 'downloads'
    default:
      return 'other-home'
  }
}
