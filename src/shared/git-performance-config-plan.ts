import {
  GIT_PERFORMANCE_CONFIG_KEYS,
  type GitPerformanceConfigEntry,
  type GitPerformanceConfigKey,
  type GitPerformanceConfigKeyPlan,
  type GitPerformanceConfigRepoState,
  type GitPerformanceConfigSkipReason
} from './git-performance-config-types'

export { GIT_PERFORMANCE_CONFIG_KEYS }

/**
 * Pure planning for Orca's opt-in repository Git tuning. Every Git and host
 * fact is passed in, so the same rules run in main (native, WSL) and on the
 * SSH relay, and the version/OS boundaries stay unit-testable.
 */

// Why in the repo's own config: any Orca client or relay that reaches this
// repository can tell Orca's values from the user's, and revert exactly them.
export const GIT_PERFORMANCE_CONFIG_RECORD_KEY = 'orca.performanceConfig'

// Why 10k: below this, v4 path compression saves little and status is already fast.
export const INDEX_V4_MIN_TRACKED_ENTRIES = 10_000

export const GIT_PERFORMANCE_CONFIG_VALUES = {
  'core.untrackedCache': 'true',
  'core.fsmonitor': 'true',
  'index.version': '4',
  'checkout.workers': '0',
  'fetch.writeCommitGraph': 'true'
} as const satisfies Record<GitPerformanceConfigKey, string>

// Why these floors: 2.25 is Orca's baseline; checkout.workers arrived in 2.32; the builtin
// daemon shipped in 2.36 but only 2.37 refuses network-mounted repositories.
export const GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION = {
  'core.untrackedCache': { major: 2, minor: 25 },
  'core.fsmonitor': { major: 2, minor: 37 },
  'index.version': { major: 2, minor: 25 },
  'checkout.workers': { major: 2, minor: 32 },
  'fetch.writeCommitGraph': { major: 2, minor: 25 }
} as const satisfies Record<GitPerformanceConfigKey, { major: number; minor: number }>

const FEATURE_MANY_FILES = 'feature.manyfiles'
// Git for Windows' pre-2.36 opt-in for the same daemon.
const LEGACY_BUILTIN_FSMONITOR = 'core.usebuiltinfsmonitor'

/** `git config --get-regexp` matches against lowercased section and variable names. */
export const GIT_PERFORMANCE_CONFIG_READ_PATTERN =
  '^(core\\.untrackedcache|core\\.fsmonitor|core\\.usebuiltinfsmonitor|index\\.version|checkout\\.workers|fetch\\.writecommitgraph|feature\\.manyfiles|orca\\.performanceconfig)$'

/** Lowercased config name to every value in Git's read order. */
export type GitConfigValues = ReadonlyMap<string, readonly string[]>

export type GitPerformanceConfigSnapshot = {
  /** `git config --local`: the only file Orca writes. */
  local: GitConfigValues
  /** Every scope Git reads, including includes and command-line config. */
  effective: GitConfigValues
}

export type GitVersion = { major: number; minor: number; patch: number }

export type GitPerformanceHostFacts = {
  /** Platform of the host that runs Git for this repository. */
  platform: NodeJS.Platform
  gitVersion: GitVersion | null
  /** True only on filesystems known to bump directory mtimes on every change. */
  reliableDirectoryMtime: boolean
  /** The user's separate opt-in for `core.fsmonitor`. */
  fsmonitorOptedIn: boolean
  fsmonitor: 'compatible' | 'incompatible' | 'unsupported'
  trackedEntryCount: number | null
}

export function parseGitConfigRegexpOutput(stdout: string): Map<string, string[]> {
  const values = new Map<string, string[]>()
  for (const record of stdout.split('\0')) {
    if (!record) {
      continue
    }
    const newline = record.indexOf('\n')
    const name = (newline === -1 ? record : record.slice(0, newline)).toLowerCase()
    // Why: a valueless key (`[core] fsmonitor`) is boolean true to Git.
    const value = newline === -1 ? 'true' : record.slice(newline + 1)
    const existing = values.get(name)
    if (existing) {
      existing.push(value)
    } else {
      values.set(name, [value])
    }
  }
  return values
}

export function parseGitVersion(output: string): GitVersion | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output)
  if (!match) {
    return null
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

export function isGitVersionAtLeast(version: GitVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor)
}

function valuesOf(values: GitConfigValues, key: string): readonly string[] {
  return values.get(key.toLowerCase()) ?? []
}

function canonicalKey(name: string): GitPerformanceConfigKey | null {
  const lowered = name.toLowerCase()
  return GIT_PERFORMANCE_CONFIG_KEYS.find((key) => key.toLowerCase() === lowered) ?? null
}

export function readGitPerformanceConfigRecord(
  local: GitConfigValues
): GitPerformanceConfigEntry[] {
  const entries: GitPerformanceConfigEntry[] = []
  for (const raw of valuesOf(local, GIT_PERFORMANCE_CONFIG_RECORD_KEY)) {
    const separator = raw.indexOf('=')
    const key = separator > 0 ? canonicalKey(raw.slice(0, separator)) : null
    if (key && !entries.some((entry) => entry.key === key)) {
      entries.push({ key, value: raw.slice(separator + 1) })
    }
  }
  return entries
}

function isOrcaOwned(entry: GitPerformanceConfigEntry, snapshot: GitPerformanceConfigSnapshot) {
  const local = valuesOf(snapshot.local, entry.key)
  return local.length === 1 && local[0] === entry.value
}

function ownedEntries(snapshot: GitPerformanceConfigSnapshot): GitPerformanceConfigEntry[] {
  return readGitPerformanceConfigRecord(snapshot.local).filter((entry) =>
    isOrcaOwned(entry, snapshot)
  )
}

/** A value outside Orca's own single local entry means some scope set it explicitly. */
function isSetOutsideOrca(
  key: GitPerformanceConfigKey,
  snapshot: GitPerformanceConfigSnapshot,
  owned: boolean
): boolean {
  return valuesOf(snapshot.effective, key).length > (owned ? 1 : 0)
}

export function summarizeGitPerformanceConfig(
  snapshot: GitPerformanceConfigSnapshot
): GitPerformanceConfigRepoState {
  const orcaKeys = ownedEntries(snapshot)
  const userKeys = GIT_PERFORMANCE_CONFIG_KEYS.filter((key) =>
    isSetOutsideOrca(
      key,
      snapshot,
      orcaKeys.some((entry) => entry.key === key)
    )
  )
  return { orcaKeys, userKeys }
}

function gateKey(
  key: GitPerformanceConfigKey,
  facts: GitPerformanceHostFacts,
  snapshot: GitPerformanceConfigSnapshot
): GitPerformanceConfigSkipReason | null {
  if (key === 'core.fsmonitor' && !facts.fsmonitorOptedIn) {
    return 'not-opted-in'
  }
  const version = facts.gitVersion
  if (!version) {
    return 'git-version-unknown'
  }
  const floor = GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION[key]
  if (!isGitVersionAtLeast(version, floor.major, floor.minor)) {
    return 'git-too-old'
  }
  // Why: any explicit feature.manyFiles is the user's own choice for these two defaults.
  const manyFilesChosen = valuesOf(snapshot.effective, FEATURE_MANY_FILES).length > 0
  switch (key) {
    case 'core.untrackedCache':
      if (manyFilesChosen) {
        return 'set-by-feature-many-files'
      }
      // Why: Scalar turns it off on Windows, where new files may not bump the directory mtime.
      if (facts.platform === 'win32') {
        return 'platform'
      }
      return facts.reliableDirectoryMtime ? null : 'filesystem'
    case 'core.fsmonitor':
      if (valuesOf(snapshot.effective, LEGACY_BUILTIN_FSMONITOR).length > 0) {
        return 'set-by-user'
      }
      if (facts.platform !== 'darwin' && facts.platform !== 'win32') {
        return 'platform'
      }
      return facts.fsmonitor === 'compatible' ? null : 'fsmonitor-incompatible'
    case 'index.version':
      if (manyFilesChosen) {
        return 'set-by-feature-many-files'
      }
      return (facts.trackedEntryCount ?? 0) >= INDEX_V4_MIN_TRACKED_ENTRIES
        ? null
        : 'small-repository'
    case 'checkout.workers':
    case 'fetch.writeCommitGraph':
      return null
  }
}

/** Which keys could still be written, so hosts can skip probes that cannot change the plan. */
export function listUnconfiguredGitPerformanceConfigKeys(
  snapshot: GitPerformanceConfigSnapshot
): GitPerformanceConfigKey[] {
  const owned = ownedEntries(snapshot)
  return GIT_PERFORMANCE_CONFIG_KEYS.filter(
    (key) =>
      !owned.some((entry) => entry.key === key) && valuesOf(snapshot.effective, key).length === 0
  )
}

export function planGitPerformanceConfig(
  facts: GitPerformanceHostFacts,
  snapshot: GitPerformanceConfigSnapshot
): GitPerformanceConfigKeyPlan[] {
  const owned = ownedEntries(snapshot)
  return GIT_PERFORMANCE_CONFIG_KEYS.map((key): GitPerformanceConfigKeyPlan => {
    const ownedEntry = owned.find((entry) => entry.key === key)
    if (ownedEntry) {
      return { key, value: ownedEntry.value, action: 'keep' }
    }
    if (isSetOutsideOrca(key, snapshot, false)) {
      return { key, action: 'skip', reason: 'set-by-user' }
    }
    const reason = gateKey(key, facts, snapshot)
    return reason
      ? { key, action: 'skip', reason }
      : { key, value: GIT_PERFORMANCE_CONFIG_VALUES[key], action: 'set' }
  })
}

/** Only values still exactly as Orca wrote them are removed; anything the user changed stays. */
export function planGitPerformanceConfigRevert(
  snapshot: GitPerformanceConfigSnapshot,
  keys?: readonly GitPerformanceConfigKey[]
): GitPerformanceConfigEntry[] {
  return ownedEntries(snapshot).filter((entry) => !keys || keys.includes(entry.key))
}

function escapeExtendedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Exact-match value pattern for `git config --unset <key> <pattern>`. */
export function exactGitConfigValuePattern(value: string): string {
  return `^${escapeExtendedRegex(value)}$`
}

/** Matches the record entries for one key, so a partial revert drops only those. */
export function gitPerformanceConfigRecordPattern(key: GitPerformanceConfigKey): string {
  return `^${escapeExtendedRegex(key)}=`
}
