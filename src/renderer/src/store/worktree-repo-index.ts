import type { Repo, Worktree } from '../../../shared/types'
import type { AppState } from './types'

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
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
  // (which replaces) can produce duplicate entries within one repo array.
  const worktreeMap = new Map<string, Worktree>()
  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      worktreeMap.set(worktree.id, worktree)
    }
  }
  const snapshot = {
    allWorktrees: Array.from(worktreeMap.values()),
    worktreeMap
  }
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  return snapshot
}

export function getIndexedAllWorktrees(worktreesByRepo: AppState['worktreesByRepo']): Worktree[] {
  return getWorktreeSnapshot(worktreesByRepo).allWorktrees
}

export function getIndexedWorktreeMap(
  worktreesByRepo: AppState['worktreesByRepo']
): Map<string, Worktree> {
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap
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
