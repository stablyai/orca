import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../types'
import { replacedWorktreeRows, type ReplacedWorktreeRow } from './worktree-catalog-membership'

type WorktreeSnapshot = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreesById: Map<string, Worktree[]>
  /** Slot of each row in allWorktrees, so a replaced row is found without a scan. */
  positions: Map<Worktree, number>
}

// Why: Zustand reruns selectors on every write, so identity projections need
// cross-render caching without pinning replaced store snapshots in memory.
const worktreeSnapshotCache = new WeakMap<AppState['worktreesByRepo'], WorktreeSnapshot>()

// Weak so a replaced catalog and its index stay collectable; a title write reads the new rows while the old ones are still live.
let lastIndexedRows: WeakRef<AppState['worktreesByRepo']> | null = null

function getWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
  const cachedSnapshot = worktreeSnapshotCache.get(worktreesByRepo)
  if (cachedSnapshot) {
    return cachedSnapshot
  }
  const previousRows = lastIndexedRows?.deref()
  const previousSnapshot = previousRows && worktreeSnapshotCache.get(previousRows)
  const replaced = previousRows && replacedWorktreeRows(worktreesByRepo, previousRows)
  const snapshot =
    previousSnapshot && replaced
      ? patchWorktreeSnapshot(previousSnapshot, replaced)
      : buildWorktreeSnapshot(worktreesByRepo)
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  lastIndexedRows = new WeakRef(worktreesByRepo)
  return snapshot
}

/** Same membership, so only replaced rows move, in place; the retired map shares this snapshot and is never read for membership again. */
function patchWorktreeSnapshot(
  snapshot: WorktreeSnapshot,
  replaced: readonly ReplacedWorktreeRow[]
): WorktreeSnapshot {
  for (const { before, after } of replaced) {
    const position = snapshot.positions.get(before)
    if (position !== undefined) {
      snapshot.allWorktrees[position] = after
      snapshot.positions.delete(before)
      snapshot.positions.set(after, position)
    }
    if (snapshot.worktreeMap.get(before.id) === before) {
      snapshot.worktreeMap.set(before.id, after)
    }
    const rows = snapshot.worktreesById.get(before.id)
    if (rows?.includes(before)) {
      // New per-id array so selectors returning one workspace's rows see the change.
      snapshot.worktreesById.set(
        before.id,
        rows.map((row) => (row === before ? after : row))
      )
    }
  }
  return snapshot
}

function buildWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeSnapshot {
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
  const positions = new Map<Worktree, number>()
  // Recover IDs from keys: snapshot getters and retained selectors require one ID read per row.
  for (const [identity, worktree] of byHostAndId) {
    const worktreeId = getWorktreeIdFromHostIdentity(identity)
    positions.set(worktree, allWorktrees.length)
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
  return { allWorktrees, worktreeMap, worktreesById, positions }
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

const hasAnyWorktreesCache = new WeakMap<AppState['worktreesByRepo'], boolean>()

export function getCachedHasAnyWorktrees(worktreesByRepo: AppState['worktreesByRepo']): boolean {
  const cached = hasAnyWorktreesCache.get(worktreesByRepo)
  if (cached !== undefined) {
    return cached
  }

  // Cache always-mounted scanner lookup by slice identity to avoid global rescans on unrelated writes.
  const hasWorktrees = Object.values(worktreesByRepo).some((worktrees) => worktrees.length > 0)
  hasAnyWorktreesCache.set(worktreesByRepo, hasWorktrees)
  return hasWorktrees
}
