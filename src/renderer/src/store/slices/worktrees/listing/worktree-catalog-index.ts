import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../types'
import {
  replacedWorktreeRows,
  sameWorktreeLineageInputs,
  sameWorktreeStructure,
  type ReplacedWorktreeRow
} from './worktree-catalog-membership'
import { ReadOnlyOverlayMap } from './read-only-overlay-map'

type WorktreeBase = {
  allWorktrees: Worktree[]
  worktreeMap: Map<string, Worktree>
  worktreesById: Map<string, Worktree[]>
  /** Slot of each row in allWorktrees, so a replaced row is found without a scan. */
  positions: Map<Worktree, number>
}

/** Compared by identity only; a new object means lineage resolution may have changed. */
export type WorktreeLineageKey = { readonly kind: 'worktree-lineage-key' }

type WorktreeOverlay = {
  /** Replaced rows by slot in base.allWorktrees, and each replacement's slot. */
  rows: ReadonlyMap<number, Worktree>
  slots: ReadonlyMap<Worktree, number>
  firstById: ReadonlyMap<string, Worktree>
  byId: ReadonlyMap<string, Worktree[]>
  /** First-host rows whose structure (path, instance, repo) moved; title-only replacements never land here. */
  structureById: ReadonlyMap<string, Worktree>
}

/** One catalog's view: an immutable base shared across title writes plus that catalog's replaced rows. */
type WorktreeSnapshot = WorktreeOverlay & {
  base: WorktreeBase
  worktreeMap: Map<string, Worktree>
  /** Structural id map; keeps its identity (and stale row objects) across title-only replacements. */
  topology: ReadonlyMap<string, Worktree>
  /** Built on first read only, so a title write with no reader copies nothing. */
  allWorktrees: Worktree[] | null
  /** Same object while no replacement could change lineage resolution; selectors key caches on it. */
  lineageKey: WorktreeLineageKey
  /** This write's replaced rows and the catalog they replaced, kept through compaction; absent after a membership rebuild. */
  replacement?: { from: WeakRef<AppState['worktreesByRepo']>; rows: readonly ReplacedWorktreeRow[] }
}

const EMPTY_OVERLAY: WorktreeOverlay = {
  rows: new Map(),
  slots: new Map(),
  firstById: new Map(),
  byId: new Map(),
  structureById: new Map()
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
    previousSnapshot && replaced
      ? overlayWorktreeSnapshot(previousSnapshot, replaced, worktreesByRepo, previousRows)
      : viewOf(buildWorktreeSnapshot(worktreesByRepo), EMPTY_OVERLAY, null)
  worktreeSnapshotCache.set(worktreesByRepo, snapshot)
  lastIndexedRows = new WeakRef(worktreesByRepo)
  return snapshot
}

function overlayOf<K, V>(base: Map<K, V>, overlay: ReadonlyMap<K, V>): Map<K, V> {
  return overlay.size === 0 ? base : new ReadOnlyOverlayMap(base, overlay)
}

/** `topology` and `lineageKey` are the previous view's when nothing structural moved, or null for new ones. */
function viewOf(
  base: WorktreeBase,
  overlay: WorktreeOverlay,
  topology: ReadonlyMap<string, Worktree> | null,
  lineageKey: WorktreeLineageKey | null = null
): WorktreeSnapshot {
  return {
    lineageKey: lineageKey ?? { kind: 'worktree-lineage-key' },
    ...overlay,
    base,
    worktreeMap: overlayOf(base.worktreeMap, overlay.firstById),
    topology: topology ?? overlayOf(base.worktreeMap, overlay.structureById),
    allWorktrees: overlay.rows.size === 0 ? base.allWorktrees : null
  }
}

/** A new view for a catalog that only replaced rows; the previous view and its base stay untouched. */
function overlayWorktreeSnapshot(
  previous: WorktreeSnapshot,
  replaced: readonly ReplacedWorktreeRow[],
  worktreesByRepo: AppState['worktreesByRepo'],
  previousRows: AppState['worktreesByRepo']
): WorktreeSnapshot {
  if (replaced.length === 0) {
    return previous
  }
  const { base } = previous
  const rows = new Map(previous.rows)
  const slots = new Map(previous.slots)
  const firstById = new Map(previous.firstById)
  const byId = new Map(previous.byId)
  const structureById = new Map(previous.structureById)
  let structureMoved = false
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
      // Same first-host rule as the title map; only a structural change replaces the topology.
      const structural = previous.topology.get(before.id)
      if (!structural || !sameWorktreeStructure(after, structural)) {
        structureMoved = true
        structureById.set(before.id, after)
      }
    }
    // Earlier replacements in this batch may already have swapped a twin in this id's list.
    const idRows = byId.get(before.id) ?? base.worktreesById.get(before.id)
    if (idRows?.includes(before)) {
      byId.set(
        before.id,
        idRows.map((row) => (row === before ? after : row))
      )
    }
  }
  const topology = structureMoved ? null : previous.topology
  const lineageKey = replaced.every(({ before, after }) => sameWorktreeLineageInputs(after, before))
    ? previous.lineageKey
    : null
  // Compaction rebuilds the title catalog; with no structure moved, surfaces keep the same topology.
  const view =
    rows.size > MAX_OVERLAY_ROWS
      ? viewOf(buildWorktreeSnapshot(worktreesByRepo), EMPTY_OVERLAY, topology, lineageKey)
      : viewOf(base, { rows, slots, firstById, byId, structureById }, topology, lineageKey)
  // Compaction rebuilds the index but not the write; weak so this catalog never keeps the one it replaced alive.
  return { ...view, replacement: { from: new WeakRef(previousRows), rows: replaced } }
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

/** A key that changes only when a write could change lineage resolution (not on title writes). */
export function getWorktreeLineageKey(
  worktreesByRepo: AppState['worktreesByRepo']
): WorktreeLineageKey {
  return getWorktreeSnapshot(worktreesByRepo).lineageKey
}

/** The rows `next` replaced in `previous`, when `next` was indexed as an overlay of exactly that catalog; null asks the caller to refresh. */
export function getIndexedReplacedRows(
  next: AppState['worktreesByRepo'],
  previous: AppState['worktreesByRepo']
): readonly ReplacedWorktreeRow[] | null {
  const snapshot = getWorktreeSnapshot(next)
  if (worktreeSnapshotCache.get(previous) === snapshot) {
    return []
  }
  return snapshot.replacement?.from.deref() === previous ? snapshot.replacement.rows : null
}

/** Structural id map for paths, lineage, and cycles; a title write keeps its identity, so its rows may carry an older title. */
export function getIndexedWorktreeTopology(
  worktreesByRepo: AppState['worktreesByRepo']
): ReadonlyMap<string, Worktree> {
  return getWorktreeSnapshot(worktreesByRepo).topology
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
