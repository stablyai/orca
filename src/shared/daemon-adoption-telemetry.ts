// Measure macOS adoption of prior-bundle daemons and cwd denials (#17696). Enum-only: never send paths, versions or exact counts.

/** How the adopted daemon's recorded app version compares to the running app. */
export const DAEMON_ADOPTED_APP_VERSION_MATCH = ['same', 'different', 'unknown'] as const
export type DaemonAdoptedAppVersionMatch = (typeof DAEMON_ADOPTED_APP_VERSION_MATCH)[number]

/** Spawner location: updater-cache is Squirrel ShipIt staging (#17696); stable-copy is Orca’s signed launchd bundle (#25848). */
export const DAEMON_SPAWNER_PATH_CLASSES = [
  'applications',
  'stable-copy',
  'updater-cache',
  'other',
  'missing',
  'unknown'
] as const
export type DaemonSpawnerPathClass = (typeof DAEMON_SPAWNER_PATH_CLASSES)[number]

export const DAEMON_TCC_ATTRIBUTION_VALUES = ['intact', 'severed', 'unknown'] as const

/** Measure executable identity (#21826): resolved means an existing non-ShipIt file, not necessarily installed app; parked means outgoing ShipIt bundle; unresolvable loses tccd identity; probe-failed means unsupported/missing/failed evidence. */
export const DAEMON_CODE_IDENTITY_VALUES = [
  'resolved',
  'parked',
  'unresolvable',
  'probe-failed'
] as const
export type DaemonCodeIdentity = (typeof DAEMON_CODE_IDENTITY_VALUES)[number]

/** Which macOS-protected folder class the denied cwd falls under. */
export const DAEMON_PTY_CWD_CLASSES = [
  'documents',
  'desktop',
  'downloads',
  'other-home',
  'outside-home'
] as const
export type DaemonPtyCwdClass = (typeof DAEMON_PTY_CWD_CLASSES)[number]

/** Offer tccutil reset only for classes with per-app TCC rows; other denial classes have no row to reset. */
export const MAC_TCC_FOLDER_CLASSES = ['documents', 'desktop', 'downloads'] as const
export type MacTccFolderClass = (typeof MAC_TCC_FOLDER_CLASSES)[number]

export function isMacTccFolderClass(cwdClass: DaemonPtyCwdClass): cwdClass is MacTccFolderClass {
  return MAC_TCC_FOLDER_CLASSES.some((name) => name === cwdClass)
}

export function classifyDaemonAppVersionMatch(
  daemonAppVersion: string | null | undefined,
  appVersion: string
): DaemonAdoptedAppVersionMatch {
  return !daemonAppVersion ? 'unknown' : daemonAppVersion === appVersion ? 'same' : 'different'
}

export function classifyDaemonSpawnerPath(
  spawnerExecPath: string | null,
  exists: (path: string) => boolean,
  stableCopyPrefix: string | null
): DaemonSpawnerPathClass {
  if (!spawnerExecPath) {
    return 'unknown'
  }
  if (!exists(spawnerExecPath)) {
    return 'missing'
  }
  if (stableCopyPrefix && spawnerExecPath.startsWith(stableCopyPrefix)) {
    return 'stable-copy'
  }
  if (/\/Library\/Caches\/[^/]*ShipIt\//.test(spawnerExecPath)) {
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
