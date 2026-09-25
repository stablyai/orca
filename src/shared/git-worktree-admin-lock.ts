import {
  gitCommonDirLockKey,
  locateGitSubcommand,
  resolveCanonicalGitCommonDir
} from './git-common-dir-location'
import { runWithGitOperationLock, type GitOperationLease } from './git-operation-lock'

// Each of these rewrites `<common-dir>/worktrees` and scans every admin entry, so two at once on one
// repo contend for the same directory. `worktree list` only reads it and stays unlocked.
const WORKTREE_ADMIN_MUTATIONS = new Set([
  'add',
  'remove',
  'move',
  'lock',
  'unlock',
  'repair',
  'prune'
])

export type GitWorktreeAdminCommand = { cwd: string; gitDir?: string }

/** Non-null when `args` mutate worktree admin data, with the repository they address. */
export function resolveGitWorktreeAdminCommand(
  args: readonly string[],
  initialCwd: string
): GitWorktreeAdminCommand | null {
  const { cwd, gitDir, subcommandIndex } = locateGitSubcommand(args, initialCwd)
  if (subcommandIndex === -1 || args[subcommandIndex] !== 'worktree') {
    return null
  }
  const verb = args.slice(subcommandIndex + 1).find((arg) => !arg.startsWith('-'))
  if (!verb || !WORKTREE_ADMIN_MUTATIONS.has(verb)) {
    return null
  }
  return gitDir ? { cwd, gitDir } : { cwd }
}

const LOCK_KEY_CACHE_LIMIT = 256
// Why cached: every admin command would otherwise re-walk `.git` markers, and on a WSL/9P repo each
// of those stats is a round trip. A repo's common dir does not move while Orca holds it open.
const lockKeyCache = new Map<string, string>()

async function resolveWorktreeAdminLockKey(
  cwd: string,
  signal: AbortSignal | undefined,
  gitDir: string | undefined
): Promise<string> {
  const cacheKey = `${gitDir ?? ''}\0${cwd}`
  const cached = lockKeyCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const location = await resolveCanonicalGitCommonDir(cwd, signal, gitDir)
  const key = gitCommonDirLockKey(location.commonDir, 'worktrees')
  // A fallback spelling for a path with no `.git` yet must not outlive the repo appearing there.
  if (location.discovered) {
    if (lockKeyCache.size >= LOCK_KEY_CACHE_LIMIT) {
      const oldest = lockKeyCache.keys().next().value
      if (oldest !== undefined) {
        lockKeyCache.delete(oldest)
      }
    }
    lockKeyCache.set(cacheKey, key)
  }
  return key
}

// Why bounded: callers already bound each git command; an unbounded queue would let a create wait
// for every queued command's timeout in turn. Past this the command runs unlocked, as before the lock.
export const WORKTREE_ADMIN_LOCK_MAX_WAIT_MS = 15_000

const UNLOCKED_LEASE: GitOperationLease = { held: false, holdUntil: () => {} }

export type GitWorktreeAdminLockOptions = {
  /** Higher runs first among queued waiters, so a user's create is not stuck behind warm-up. */
  readonly priority?: number
  readonly maxWaitMs?: number
}

/**
 * Serializes worktree admin mutations for one repository within this process.
 *
 * The lock is a load-shaping aid, not a correctness guard — git's own lock files own correctness —
 * so a failure to derive the key logs and runs the command unlocked rather than blocking it.
 */
export async function runWithGitWorktreeAdminLock<T>(
  command: GitWorktreeAdminCommand,
  signal: AbortSignal | undefined,
  run: (lease: GitOperationLease) => Promise<T>,
  options: GitWorktreeAdminLockOptions = {}
): Promise<T> {
  let key: string
  try {
    key = await resolveWorktreeAdminLockKey(command.cwd, signal, command.gitDir)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    console.warn('[git] worktree admin lock unavailable; running unlocked', error)
    return run(UNLOCKED_LEASE)
  }
  const maxWaitMs = options.maxWaitMs ?? WORKTREE_ADMIN_LOCK_MAX_WAIT_MS
  return runWithGitOperationLock(
    key,
    signal,
    (lease) => {
      if (!lease.held) {
        console.warn(`[git] worktree admin lock still busy after ${maxWaitMs} ms; running unlocked`)
      }
      return run(lease)
    },
    { priority: options.priority, maxWaitMs }
  )
}

/** The lane key a command would queue on; exposed so tests can hold or inspect that lane. */
export function _resolveGitWorktreeAdminLockKeyForTests(cwd: string): Promise<string> {
  return resolveWorktreeAdminLockKey(cwd, undefined, undefined)
}

export function _resetGitWorktreeAdminLockCacheForTests(): void {
  lockKeyCache.clear()
}
