import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../types'

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  duplicatesById: Map<string, Worktree[]> | null
  singleArrayById: Map<string, Worktree[]> | null
}

const EMPTY_WORKTREES: Worktree[] = []

// Why: Zustand reruns selectors on every write, so identity projections need
// cross-render caching without pinning replaced store snapshots in memory.
const worktreeSnapshotCache = new WeakMap<AppState['worktreesByRepo'], WorktreeSnapshot>()

function getWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
  const cachedSnapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (cachedSnapshot) {
    return cachedSnapshot
  }

  // Deduplicate same-host create/fetch races, last wins. repoId::path collides across hosts; retain those rows or one workspace vanishes (STA-4343).
  const byHostAndId = new Map<string, Worktree>()
  for (const repoId in worktreesByRepo) {
    if (!Object.hasOwn(worktreesByRepo, repoId)) {
      continue
    }
    for (const worktree of worktreesByRepo[repoId]) {
      byHostAndId.set(composeWorktreeHostIdentity(worktree.hostId, worktree.id), worktree)
    }
  }
  const allWorktrees: Worktree[] = []
  const worktreeMap = new Map<string, Worktree>()
  let duplicatesById: Map<string, Worktree[]> | null = null
  // Recover IDs from keys: snapshot getters and retained selectors require one ID read per row.
  for (const [identity, worktree] of byHostAndId) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    allWorktrees.push(worktree)
    // First host wins for legacy bare-ID lookups, matching buildWorktreeByIdIndex/.find; freshness cannot resolve distinct owners.
    const existing = worktreeMap.get(worktreeId)
    if (existing === undefined) {
      worktreeMap.set(worktreeId, worktree)
    } else {
      duplicatesById ??= new Map()
      const rows = duplicatesById.get(worktreeId)
      if (rows) {
        rows.push(worktree)
      } else {
        duplicatesById.set(worktreeId, [existing, worktree])
      }
    }
  }
  const snapshot: WorktreeSnapshot = {
    allWorktrees,
    worktreeMap,
    duplicatesById,
    singleArrayById: null
  }
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
  const snapshot = getWorktreeSnapshot(worktreesByRepo)
  const duplicates = snapshot.duplicatesById?.get(worktreeId)
  if (duplicates) {
    return duplicates
  }
  const single = snapshot.worktreeMap.get(worktreeId)
  if (!single) {
    return EMPTY_WORKTREES
  }
  snapshot.singleArrayById ??= new Map()
  let cached = snapshot.singleArrayById.get(worktreeId)
  if (!cached) {
    cached = [single]
    snapshot.singleArrayById.set(worktreeId, cached)
  }
  return cached
}

export function getIndexedWorktreeById(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): Worktree | undefined {
  return getWorktreeSnapshot(worktreesByRepo).worktreeMap.get(worktreeId)
}

const hasAnyWorktreesCache = new WeakMap<AppState['worktreesByRepo'], boolean>()

export function getCachedHasAnyWorktrees(worktreesByRepo: AppState['worktreesByRepo']): boolean {
  const cached = hasAnyWorktreesCache.get(worktreesByRepo)
  if (cached !== undefined) {
    return cached
  }

  // Cache always-mounted scanner lookup by slice identity to avoid global rescans on unrelated writes.
  let hasWorktrees = false
  for (const repoId in worktreesByRepo) {
    if (Object.hasOwn(worktreesByRepo, repoId) && worktreesByRepo[repoId].length > 0) {
      hasWorktrees = true
      break
    }
  }
  hasAnyWorktreesCache.set(worktreesByRepo, hasWorktrees)
  return hasWorktrees
}
