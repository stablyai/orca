import type { Worktree } from '../../../../../shared/worktree/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import { linkOf, type Keyed } from '@/store/keyed-record-transitions'
import {
  detectedWorktreeChangesAreIrrelevant,
  type DetectedRowCatalog
} from './detected-worktree-row-changes'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type Catalog = DetectedRowCatalog<WorktreeOwnerRecord>
type Location = { bucket: string; position: number }
type DetectedIndex = {
  source: Catalog
  locationsById: ReadonlyMap<string, readonly Location[]>
  matches: Map<string, readonly WorktreeOwnerRecord[]>
}

// The same immutable catalog index owns raw row locations and narrow owner answers.
const detectedWorktreeIndexCache = new WeakMap<Keyed, DetectedIndex>()
const NO_DETECTED_WORKTREES: readonly WorktreeOwnerRecord[] = []

function indexedPredecessor(catalog: Catalog): DetectedIndex | undefined {
  let current: Keyed = catalog
  for (let depth = 0; depth < 64; depth++) {
    const step = linkOf(current)
    if (!step || 'reason' in step) {
      return undefined
    }
    const previous = step.previous.deref()
    if (!previous) {
      return undefined
    }
    const index = detectedWorktreeIndexCache.get(previous)
    if (index) {
      return index
    }
    current = previous
  }
  return undefined
}

function detectedIndex(catalog: Catalog): DetectedIndex {
  const cached = detectedWorktreeIndexCache.get(catalog)
  if (cached) {
    return cached
  }
  const previous = indexedPredecessor(catalog)
  const locationsById =
    previous &&
    detectedWorktreeChangesAreIrrelevant<Catalog[string]>(
      previous.source,
      catalog,
      (before, after) => !!before && !!after && before.id === after.id
    )
      ? previous.locationsById
      : indexLocations(catalog)
  const index: DetectedIndex = { source: catalog, locationsById, matches: new Map() }
  detectedWorktreeIndexCache.set(catalog, index)
  return index
}

function indexLocations(catalog: Catalog): ReadonlyMap<string, readonly Location[]> {
  const locations = new Map<string, Location[]>()
  for (const [bucket, listing] of Object.entries(catalog)) {
    listing.worktrees.forEach((row, position) => {
      const id = row.id
      const at = locations.get(id)
      if (at) {
        at.push({ bucket, position })
      } else {
        locations.set(id, [{ bucket, position }])
      }
    })
  }
  return locations
}

/** Original detected rows in publication order, including unstamped and duplicate owners. */
export function findIndexedDetectedWorktreeRows<W extends WorktreeOwnerRecord>(
  catalog: DetectedRowCatalog<W> | undefined,
  worktreeId: string
): W[] {
  if (!catalog) {
    return []
  }
  const locations = detectedIndex(catalog).locationsById.get(worktreeId)
  return (locations ?? []).flatMap(({ bucket, position }) => {
    const row = catalog[bucket]?.worktrees[position]
    return row ? [row] : []
  })
}

/** Physical-host filtering preserves the narrow API's original all-publication semantics. */
export function findIndexedDetectedWorktrees(
  catalog: Catalog | undefined,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): readonly WorktreeOwnerRecord[] {
  if (!catalog) {
    return NO_DETECTED_WORKTREES
  }
  const index = detectedIndex(catalog)
  const key = executionHostId ? `${worktreeId}\0${executionHostId}` : worktreeId
  let rows = index.matches.get(key)
  if (!rows) {
    const original = findIndexedDetectedWorktreeRows(catalog, worktreeId)
    rows = executionHostId
      ? original.filter((row) => parseExecutionHostId(row.hostId)?.id === executionHostId)
      : original
    if (rows.length) {
      index.matches.set(key, rows)
    }
  }
  return rows.length ? rows : NO_DETECTED_WORKTREES
}

export function hasIndexedDetectedWorktree(
  catalog: Catalog | undefined,
  worktreeId: string
): boolean {
  return findIndexedDetectedWorktrees(catalog, worktreeId).length > 0
}
