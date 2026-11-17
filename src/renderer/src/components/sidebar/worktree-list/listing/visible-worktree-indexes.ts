import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  replacedWorktreeRows,
  type ReplacedWorktreeRow
} from '@/store/slices/worktrees/listing/worktree-catalog-membership'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { ReadOnlyOverlayMap } from '@/store/slices/worktrees/listing/read-only-overlay-map'

type WorktreesByRepo = Record<string, Worktree[]>

type LineageIndex = {
  /** Immutable index shared by every catalog that only replaced rows since it was built. */
  base: Map<string, Worktree>
  overlay: ReadonlyMap<string, Worktree>
  index: Map<string, Worktree>
}

// Past this many replaced rows, a rebuild costs less than carrying the overlay.
const MAX_LINEAGE_OVERLAY = 64

/** Cache non-archived rows by host identity to preserve twins and avoid repeated lineage/cycle scans. */
const lineageAncestorIndexCache = new WeakMap<WorktreesByRepo, LineageIndex>()
// Weak so a replaced catalog's lineage index stays collectable.
let lastLineageRows: WeakRef<WorktreesByRepo> | null = null

export function getLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const cached = lineageAncestorIndexCache.get(worktreesByRepo)
  if (cached) {
    return cached.index
  }
  const previousRows = lastLineageRows?.deref()
  const previous = previousRows && lineageAncestorIndexCache.get(previousRows)
  const replaced = previousRows && replacedWorktreeRows(worktreesByRepo, previousRows)
  const lineage =
    (previous && replaced && overlayLineageIndex(previous, replaced)) ||
    lineageView(buildLineageAncestorIndex(worktreesByRepo), new Map())
  lineageAncestorIndexCache.set(worktreesByRepo, lineage)
  lastLineageRows = new WeakRef(worktreesByRepo)
  return lineage.index
}

function lineageView(
  base: Map<string, Worktree>,
  overlay: ReadonlyMap<string, Worktree>
): LineageIndex {
  return {
    base,
    overlay,
    index: overlay.size === 0 ? base : new ReadOnlyOverlayMap(base, overlay)
  }
}

/** Archive state is unchanged for replaced rows, so a row is indexed exactly when its predecessor was. Null asks for a rebuild. */
function overlayLineageIndex(
  previous: LineageIndex,
  replaced: readonly ReplacedWorktreeRow[]
): LineageIndex | null {
  if (replaced.length === 0) {
    return previous
  }
  const overlay = new Map(previous.overlay)
  for (const { before, after } of replaced) {
    const identity = getWorktreeHostIdentity(before)
    if (previous.index.get(identity) !== before) {
      continue
    }
    if (previous.base.get(identity) === after) {
      overlay.delete(identity)
    } else {
      overlay.set(identity, after)
    }
  }
  return overlay.size > MAX_LINEAGE_OVERLAY ? null : lineageView(previous.base, overlay)
}

function buildLineageAncestorIndex(worktreesByRepo: WorktreesByRepo): Map<string, Worktree> {
  const index = new Map<string, Worktree>()
  for (const worktree of getIndexedAllWorktrees(worktreesByRepo)) {
    if (!worktree.isArchived) {
      index.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
  return index
}

/** Reuse ranks while the frozen sidebar sort array retains its identity. */
const sortedWorktreeRankIndexCache = new WeakMap<readonly string[], Map<string, number>>()

export function getSortedWorktreeRankIndex(sortedIds: readonly string[]): Map<string, number> {
  const cached = sortedWorktreeRankIndexCache.get(sortedIds)
  if (cached) {
    return cached
  }
  const index = new Map(sortedIds.map((id, rank) => [id, rank]))
  sortedWorktreeRankIndexCache.set(sortedIds, index)
  return index
}
