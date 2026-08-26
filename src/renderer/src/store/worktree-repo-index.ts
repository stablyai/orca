import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { AppState } from './types'

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreesById: Map<string, Worktree[]>
}

// Why: Zustand reruns selectors on every write, so identity projections need
// cross-render caching without pinning replaced store snapshots in memory.
const worktreeSnapshotCache = new WeakMap<AppState['worktreesByRepo'], WorktreeSnapshot>()
const repoMapCache = new WeakMap<AppState['repos'], Map<string, Repo>>()

function getWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
  const cachedSnapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  // Why: a race between createWorktree (which appends) and fetchWorktrees
  // (which replaces) can produce duplicate entries within one repo array. That
  // duplicate is the SAME workspace twice, so it collapses — but the key has to
  // include the host (STA-4343). `worktreeId` is `repoId::path` with no host
  // component, so the local host and an SSH host can publish the same id for
  // two genuinely different workspaces, and collapsing those hides one of them
  // from the sidebar entirely. Last wins within a host: fetchWorktrees replaces,
  // so the later entry is the current one.
  const byHostAndId = new Map<string, Worktree>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      byHostAndId.set(composeWorktreeHostIdentity(worktree.hostId, worktree.id), worktree)
    }
  }
  const allWorktrees: Worktree[] = []
  const worktreeMap = new Map<string, Worktree>()
  const worktreesById = new Map<string, Worktree[]>()
  // Why the identity round-trip: `worktree.id` is a getter on some snapshots and
  // retained selectors assert it is read exactly once per row, so recover the id
  // from the key instead of reading the property again.
  for (const [identity, worktree] of byHostAndId) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    allWorktrees.push(worktree)
    // FIRST wins across hosts, matching `buildWorktreeByIdIndex` and the `.find()`
    // both replaced. Freshness is not the question here: the same-host duplicate
    // was already collapsed above, so what is left is a genuine two-host collision
    // that no bare-id lookup can resolve.
    if (!worktreeMap.has(worktreeId)) {
      worktreeMap.set(worktreeId, worktree)
    }
    const rows = worktreesById.get(worktreeId)
    if (rows) {
      rows.push(worktree)
    } else {
      worktreesById.set(worktreeId, [worktree])
    }
  }
  const snapshot = { allWorktrees, worktreeMap, worktreesById }
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  return snapshot
}

export function getIndexedAllWorktrees(worktreesByRepo: AppState['worktreesByRepo']): Worktree[] {
  return getWorktreeSnapshot(worktreesByRepo).allWorktrees
}

/**
 * One row per id — a LEGACY convenience for the many id-only lookups.
 *
 * It cannot represent a collision, so it is not evidence of ownership: a
 * destructive path must take an explicit host (see `WorktreeRemovalTarget`) and
 * use `getIndexedWorktreesById` when it needs to see every owner.
 */
export function getIndexedWorktreeMap(
  worktreesByRepo: AppState['worktreesByRepo']
): Map<string, Worktree> {
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap
}

/** Every host's row for one id, in `worktreesByRepo` order. */
export function getIndexedWorktreesById(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): Worktree[] {
  return getWorktreeSnapshot(worktreesByRepo).worktreesById.get(worktreeId) ?? []
}

export function getIndexedWorktreeById(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): Worktree | undefined {
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap.get(worktreeId)
}

export function getIndexedRepoMap(repos: AppState['repos']): Map<string, Repo> {
  const cachedMap = repoMapCache.get(repos)
  if (cachedMap) {
    return cachedMap
  }
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  repoMapCache.set(repos, repoMap)
  return repoMap
}
