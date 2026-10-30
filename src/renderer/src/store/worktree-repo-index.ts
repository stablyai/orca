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

  // Deduplicate same-host create/fetch races, last wins. repoId::path collides across hosts; retain those rows or one workspace vanishes (STA-4343).
  const byHostAndId = new Map<string, Worktree>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      byHostAndId.set(composeWorktreeHostIdentity(worktree.hostId, worktree.id), worktree)
    }
  }
  const allWorktrees: Worktree[] = []
  const worktreeMap = new Map<string, Worktree>()
  const worktreesById = new Map<string, Worktree[]>()
  // Recover IDs from keys: snapshot getters and retained selectors require one ID read per row.
  for (const [identity, worktree] of byHostAndId) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    allWorktrees.push(worktree)
    // First host wins for legacy bare-ID lookups, matching buildWorktreeByIdIndex/.find; freshness cannot resolve distinct owners.
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

/** Legacy bare-ID view cannot prove ownership amid collisions; destructive paths need explicit WorktreeRemovalTarget hosts and getIndexedWorktreesById. */
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
