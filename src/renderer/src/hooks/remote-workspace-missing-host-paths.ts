import {
  PATH_EXISTENCE_BATCH_MAX,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../shared/execution-host'
import type { DirectSshAuthority } from '../../../shared/ssh-types'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { RemoteWorkspaceSnapshotPlacementStore } from './remote-workspace-snapshot-placement'

export type ReadHostPathExistence = (
  targetId: string,
  paths: string[]
) => Promise<PathExistenceResult[]>

export const HOST_PATH_MISSING_CONFIRM_DELAY_MS = 2_000

/**
 * Host paths the relay positively answered ENOENT for.
 *
 * Only `{ exists: false }` counts: a failed batch, a per-path error, or a short answer is
 * `unverifiable` and stays out, so the caller keeps treating that path as a placement conflict
 * (docs/reference/ssh-execution-boundary.md).
 */
export async function findPathsMissingOnHost(
  readHostPathExistence: ReadHostPathExistence,
  targetId: string,
  paths: readonly string[]
): Promise<Set<string>> {
  const unique = [...new Set(paths)]
  const missing = new Set<string>()
  for (let start = 0; start < unique.length; start += PATH_EXISTENCE_BATCH_MAX) {
    const batch = unique.slice(start, start + PATH_EXISTENCE_BATCH_MAX)
    let results: PathExistenceResult[]
    try {
      results = await readHostPathExistence(targetId, batch)
    } catch {
      continue
    }
    batch.forEach((path, index) => {
      const result = results[index]
      if (result && 'exists' in result && !result.exists) {
        missing.add(path)
      }
    })
  }
  return missing
}

/**
 * Paths the host reported ENOENT for on two probes `confirmDelayMs` apart.
 *
 * Why a second probe: one ENOENT can be a non-atomic move (remove + recreate) caught mid-flight;
 * like the advisory/authoritative split in local metadata pruning, only a path gone twice is purged.
 * In-apply rather than on the next pull, because a lingering conflict freezes every upload for the host.
 */
export async function confirmPathsMissingOnHost(
  readHostPathExistence: ReadHostPathExistence,
  targetId: string,
  paths: readonly string[],
  isCurrent: () => boolean,
  confirmDelayMs: number = HOST_PATH_MISSING_CONFIRM_DELAY_MS
): Promise<Set<string>> {
  const firstMissing = await findPathsMissingOnHost(readHostPathExistence, targetId, paths)
  if (firstMissing.size === 0 || !isCurrent()) {
    return new Set()
  }
  await new Promise<void>((resolve) => setTimeout(resolve, confirmDelayMs))
  if (!isCurrent()) {
    return new Set()
  }
  return findPathsMissingOnHost(readHostPathExistence, targetId, [...firstMissing])
}

/**
 * Drop this client's rows for worktrees whose directory the host reported gone, and return the
 * paths that are now fully released (no client row left under them).
 *
 * Why: such a key is invisible (no catalog row places it), yet the export filter only checks repo
 * ownership, so every upload would re-publish it to the host snapshot and the next pull would
 * trip over it again. This is the same purge an authoritative listing runs for a removed worktree.
 * A path whose row survives stays unplaced: syncing would keep re-publishing it.
 */
export function purgeClientRowsForMissingHostPaths(
  store: RemoteWorkspaceSnapshotPlacementStore,
  authority: DirectSshAuthority,
  missingPaths: ReadonlySet<string>,
  placedWorktreeIds: ReadonlySet<string>
): Set<string> {
  if (missingPaths.size === 0) {
    return new Set()
  }
  const missingKeys = new Set([...missingPaths].map(normalizeRuntimePathForComparison))
  const state = store.getState()
  const retainedKeys = new Set<string>()
  const staleIds = Object.keys(state.tabsByWorktree).filter((worktreeId) => {
    const parsed = splitWorktreeId(worktreeId)
    const pathKey = parsed ? normalizeRuntimePathForComparison(parsed.worktreePath) : null
    if (!parsed || !pathKey || !missingKeys.has(pathKey)) {
      return false
    }
    // A catalog row still names this worktree (e.g. two ids share the path, so placement
    // refused both); its tabs survive, so the path is not released.
    if (placedWorktreeIds.has(worktreeId)) {
      retainedKeys.add(pathKey)
      return false
    }
    // A repo id registered on another host too could name a live local path; leave it alone.
    // Ownership may be spelled only as `executionHostId: ssh:<target>` (#11163).
    const repoRows = state.repos.filter((repo) => repo.id === parsed.repoId)
    const owned =
      repoRows.length > 0 &&
      repoRows.every(
        (repo) =>
          getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo)) === authority.targetId
      )
    if (!owned) {
      retainedKeys.add(pathKey)
    }
    return owned
  })
  if (staleIds.length > 0) {
    state.purgeWorktreeTerminalState(staleIds)
  }
  return new Set(
    [...missingPaths].filter((path) => !retainedKeys.has(normalizeRuntimePathForComparison(path)))
  )
}
