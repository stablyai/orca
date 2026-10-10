import type { GitCapabilityCache } from './git-capability-cache'
import { readGitIndexEntryCount } from './git-performance-config-filesystem'
import {
  GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION,
  GIT_PERFORMANCE_CONFIG_READ_PATTERN,
  GIT_PERFORMANCE_CONFIG_RECORD_KEY,
  listUnconfiguredGitPerformanceConfigKeys,
  parseGitConfigRegexpOutput,
  parseGitVersion,
  planGitPerformanceConfig,
  planGitPerformanceConfigRevert,
  readGitPerformanceConfigRecord,
  summarizeGitPerformanceConfig,
  exactGitConfigValuePattern,
  gitPerformanceConfigRecordPattern,
  isGitVersionAtLeast,
  type GitPerformanceConfigSnapshot,
  type GitPerformanceHostFacts
} from './git-performance-config-plan'
import { parseWorktreeList } from './git-worktree-porcelain-parser'
import type {
  GitPerformanceConfigAction,
  GitPerformanceConfigKey,
  GitPerformanceConfigOptions,
  GitPerformanceConfigResult
} from './git-performance-config-types'

/** Everything the runner needs from the host that executes Git for one repository. */
export type GitPerformanceConfigHost = {
  platform: NodeJS.Platform
  /** Runs Git with the repository as cwd; rejects with `code`/`stdout`/`stderr` on non-zero exit. */
  git: (args: string[]) => Promise<{ stdout: string; stderr: string }>
  /** Scoped to this execution host (native, WSL distro, relay). */
  capabilities: GitCapabilityCache
  hasReliableDirectoryMtime: () => Promise<boolean>
  /** Turns a path Git printed (relative to the repo or absolute) into one this process can open. */
  resolveGitPath: (gitPath: string) => string
}

// Why: fixed bound so a revert never fans out over an unbounded worktree list.
const MAX_FSMONITOR_DAEMON_STOPS = 256

function errorField(error: unknown, field: 'code' | 'stdout' | 'stderr' | 'message'): unknown {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined
  }
  return Reflect.get(error, field)
}

function errorText(error: unknown): string {
  return (['message', 'stderr', 'stdout'] as const)
    .map((field) => errorField(error, field))
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

function exitedWith(error: unknown, code: number): boolean {
  return errorField(error, 'code') === code
}

// Exit 5: the key or value pattern no longer matches, so there is nothing left to remove.
function ignoreExit5(error: unknown): void {
  if (!exitedWith(error, 5)) {
    throw error
  }
}

/** Git < 2.36 lacks the subcommand; Linux builds before 2.55 compile it out. */
export function isFsmonitorDaemonUnsupportedError(error: unknown): boolean {
  return /'fsmonitor--daemon' is not a git command|fsmonitor--daemon not supported on this platform/.test(
    errorText(error)
  )
}

async function readConfigValues(host: GitPerformanceConfigHost, scope: string[]) {
  try {
    const { stdout } = await host.git([
      'config',
      ...scope,
      '-z',
      '--get-regexp',
      GIT_PERFORMANCE_CONFIG_READ_PATTERN
    ])
    return parseGitConfigRegexpOutput(stdout)
  } catch (error) {
    // Exit 1: none of the keys is set.
    if (exitedWith(error, 1)) {
      return new Map<string, string[]>()
    }
    throw error
  }
}

export async function readGitPerformanceConfigSnapshot(
  host: GitPerformanceConfigHost
): Promise<GitPerformanceConfigSnapshot> {
  const [local, effective] = await Promise.all([
    readConfigValues(host, ['--local']),
    readConfigValues(host, [])
  ])
  return { local, effective }
}

/** Read-only: `status` never starts the daemon, and incompatibility is a per-repo answer. */
export async function probeFsmonitorDaemon(
  host: GitPerformanceConfigHost
): Promise<GitPerformanceHostFacts['fsmonitor']> {
  return host.capabilities.runWithFallback(
    'fsmonitor-daemon',
    async () => {
      try {
        await host.git(['fsmonitor--daemon', 'status'])
        return 'compatible' as const
      } catch (error) {
        if (/fsmonitor-daemon is not watching/.test(errorText(error))) {
          return 'compatible' as const
        }
        // 2.37+ refuses network, virtual and socket-less repos; 2.38+ honors fsmonitor.allowRemote.
        if (/is incompatible with fsmonitor/.test(errorText(error))) {
          return 'incompatible' as const
        }
        throw error
      }
    },
    async () => 'unsupported' as const,
    isFsmonitorDaemonUnsupportedError
  )
}

async function readTrackedEntryCount(host: GitPerformanceConfigHost): Promise<number | null> {
  const { stdout } = await host.git(['rev-parse', '--git-path', 'index'])
  const indexPath = stdout.trim()
  return indexPath ? readGitIndexEntryCount(host.resolveGitPath(indexPath)) : null
}

async function collectHostFacts(
  host: GitPerformanceConfigHost,
  snapshot: GitPerformanceConfigSnapshot,
  fsmonitorOptedIn: boolean
): Promise<GitPerformanceHostFacts> {
  const gitVersion = parseGitVersion((await host.git(['--version'])).stdout)
  const open = new Set(listUnconfiguredGitPerformanceConfigKeys(snapshot))
  const fsmonitorFloor = GIT_PERFORMANCE_CONFIG_MIN_GIT_VERSION['core.fsmonitor']
  const canUseFsmonitor =
    fsmonitorOptedIn &&
    open.has('core.fsmonitor') &&
    (host.platform === 'darwin' || host.platform === 'win32') &&
    gitVersion !== null &&
    isGitVersionAtLeast(gitVersion, fsmonitorFloor.major, fsmonitorFloor.minor)
  const [reliableDirectoryMtime, fsmonitor, trackedEntryCount] = await Promise.all([
    open.has('core.untrackedCache') && host.platform !== 'win32'
      ? host.hasReliableDirectoryMtime().catch(() => false)
      : Promise.resolve(false),
    canUseFsmonitor
      ? probeFsmonitorDaemon(host).catch(() => 'incompatible' as const)
      : Promise.resolve('unsupported' as const),
    open.has('index.version')
      ? readTrackedEntryCount(host).catch(() => null)
      : Promise.resolve(null)
  ])
  return {
    platform: host.platform,
    gitVersion,
    reliableDirectoryMtime,
    fsmonitorOptedIn,
    fsmonitor,
    trackedEntryCount
  }
}

async function stopFsmonitorDaemons(host: GitPerformanceConfigHost): Promise<void> {
  const { stdout } = await host.git(['worktree', 'list', '--porcelain'])
  for (const worktree of parseWorktreeList(stdout).slice(0, MAX_FSMONITOR_DAEMON_STOPS)) {
    // Not running is the common answer; nothing to undo then.
    await host.git(['-C', worktree.path, 'fsmonitor--daemon', 'stop']).catch(() => {})
  }
}

async function revertOwnedKeys(
  host: GitPerformanceConfigHost,
  snapshot: GitPerformanceConfigSnapshot,
  keys?: readonly GitPerformanceConfigKey[]
): Promise<GitPerformanceConfigKey[]> {
  const owned = planGitPerformanceConfigRevert(snapshot, keys)
  for (const entry of owned) {
    // Why the value pattern: a value the user changed since the snapshot is theirs and stays.
    await host
      .git(['config', '--local', '--unset', entry.key, exactGitConfigValuePattern(entry.value)])
      .catch(ignoreExit5)
  }
  if (snapshot.local.has(GIT_PERFORMANCE_CONFIG_RECORD_KEY.toLowerCase())) {
    const recordPatterns = keys ? keys.map(gitPerformanceConfigRecordPattern) : [null]
    for (const pattern of recordPatterns) {
      await host
        .git([
          'config',
          '--local',
          '--unset-all',
          GIT_PERFORMANCE_CONFIG_RECORD_KEY,
          ...(pattern ? [pattern] : [])
        ])
        .catch(ignoreExit5)
    }
  }
  const reverted = owned.map((entry) => entry.key)
  if (reverted.includes('core.fsmonitor')) {
    const after = await readGitPerformanceConfigSnapshot(host)
    if (!after.effective.has('core.fsmonitor')) {
      await stopFsmonitorDaemons(host).catch(() => {})
    }
  }
  return reverted
}

async function applyGitPerformanceConfig(
  host: GitPerformanceConfigHost,
  options: GitPerformanceConfigOptions
): Promise<GitPerformanceConfigResult> {
  const fsmonitorOptedIn = options.fsmonitor === true
  let snapshot = await readGitPerformanceConfigSnapshot(host)
  // Why: an apply without the file-watcher opt-in also takes back a watcher Orca set earlier.
  if (!fsmonitorOptedIn) {
    const removed = await revertOwnedKeys(host, snapshot, ['core.fsmonitor'])
    if (removed.length > 0) {
      snapshot = await readGitPerformanceConfigSnapshot(host)
    }
  }
  const plan = planGitPerformanceConfig(
    await collectHostFacts(host, snapshot, fsmonitorOptedIn),
    snapshot
  )
  const recorded = readGitPerformanceConfigRecord(snapshot.local)
  for (const entry of plan) {
    if (entry.action !== 'set') {
      continue
    }
    // Why record first: an interrupted apply then leaves a record with no value, which
    // revert drops, instead of an unrecorded value that would later read as the user's.
    if (!recorded.some((existing) => existing.key === entry.key)) {
      await host.git([
        'config',
        '--local',
        '--add',
        GIT_PERFORMANCE_CONFIG_RECORD_KEY,
        `${entry.key}=${entry.value}`
      ])
    }
    await host.git(['config', '--local', entry.key, entry.value])
  }
  return {
    state: summarizeGitPerformanceConfig(await readGitPerformanceConfigSnapshot(host)),
    plan
  }
}

export async function runGitPerformanceConfigAction(
  host: GitPerformanceConfigHost,
  action: GitPerformanceConfigAction,
  options: GitPerformanceConfigOptions = {}
): Promise<GitPerformanceConfigResult> {
  if (action === 'apply') {
    return applyGitPerformanceConfig(host, options)
  }
  if (action === 'revert') {
    const reverted = await revertOwnedKeys(
      host,
      await readGitPerformanceConfigSnapshot(host),
      options.keys
    )
    return {
      state: summarizeGitPerformanceConfig(await readGitPerformanceConfigSnapshot(host)),
      reverted
    }
  }
  return { state: summarizeGitPerformanceConfig(await readGitPerformanceConfigSnapshot(host)) }
}
