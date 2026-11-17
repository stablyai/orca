import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../types'
import { replacedWorktreeRows, type ReplacedWorktreeRow } from './worktree-catalog-membership'
import { ReadOnlyOverlayMap } from './read-only-overlay-map'

type WorktreeBase = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreesById: Map<string, Worktree[]>
  /** Slot of each row in allWorktrees, so a replaced row is found without a scan. */
  positions: Map<Worktree, number>
}

/** One catalog's view: an immutable base shared across title writes plus that catalog's replaced rows. */
type WorktreeSnapshot = {
  base: WorktreeBase
  /** Replaced rows by slot in base.allWorktrees, and each replacement's slot. */
  rows: ReadonlyMap<number, Worktree>
  slots: ReadonlyMap<Worktree, number>
  firstById: ReadonlyMap<string, Worktree>
  byId: ReadonlyMap<string, Worktree[]>
  worktreeMap: Map<string, Worktree>
  /** Built on first read only, so a title write with no reader copies nothing. */
  allWorktrees: Worktree[] | null
}

// Past this many replaced rows, a rebuild costs less than carrying the overlay.
const MAX_OVERLAY_ROWS = 64

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
    (previousSnapshot && replaced && overlayWorktreeSnapshot(previousSnapshot, replaced)) ||
    viewOf(buildWorktreeSnapshot(worktreesByRepo))
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  lastIndexedRows = new WeakRef(worktreesByRepo)
  return snapshot
}

function viewOf(
  base: WorktreeBase,
  rows: ReadonlyMap<number, Worktree> = new Map(),
  slots: ReadonlyMap<Worktree, number> = new Map(),
  firstById: ReadonlyMap<string, Worktree> = new Map(),
  byId: ReadonlyMap<string, Worktree[]> = new Map()
): WorktreeSnapshot {
  return {
    base,
    rows,
    slots,
    firstById,
    byId,
    worktreeMap:
      firstById.size === 0 ? base.worktreeMap : new ReadOnlyOverlayMap(base.worktreeMap, firstById),
    allWorktrees: rows.size === 0 ? base.allWorktrees : null
  }
}

/** A new view for a catalog that only replaced rows; the previous view and its base stay untouched. Null asks for a rebuild. */
function overlayWorktreeSnapshot(
  previous: WorktreeSnapshot,
  replaced: readonly ReplacedWorktreeRow[]
): WorktreeSnapshot | null {
  if (replaced.length === 0) {
    return previous
  }
  const { base } = previous
  const rows = new Map(previous.rows)
  const slots = new Map(previous.slots)
  const firstById = new Map(previous.firstById)
  const byId = new Map(previous.byId)
  for (const { before, after } of replaced) {
    const slot = base.positions.get(before) ?? previous.slots.get(before)
    if (slot !== undefined) {
      slots.delete(before)
      if (base.allWorktrees[slot] === after) {
        rows.delete(slot)
      } else {
        rows.set(slot, after)
        slots.set(after, slot)
      }
    }
    if (previous.worktreeMap.get(before.id) === before) {
      if (base.worktreeMap.get(before.id) === after) {
        firstById.delete(before.id)
      } else {
        firstById.set(before.id, after)
      }
    }
    const idRows = previous.byId.get(before.id) ?? base.worktreesById.get(before.id)
    if (idRows?.includes(before)) {
      byId.set(
        before.id,
        idRows.map((row) => (row === before ? after : row))
      )
    }
  }
  return rows.size > MAX_OVERLAY_ROWS ? null : viewOf(base, rows, slots, firstById, byId)
}

function rowsOf(snapshot: WorktreeSnapshot): Worktree[] {
  // One pointer copy per catalog, shared by every reader of it; the base array is never written.
  snapshot.allWorktrees ??= Array.from(
    snapshot.base.allWorktrees,
    (row, slot) => snapshot.rows.get(slot) ?? row
  )
  return snapshot.allWorktrees
}

function buildWorktreeSnapshot(worktreesByRepo: AppState['worktreesByRepo']): WorktreeBase {
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
  return rowsOf(getWorktreeSnapshot(worktreesByRepo))
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
  return snapshot.byId.get(worktreeId) ?? snapshot.base.worktreesById.get(worktreeId) ?? []
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
