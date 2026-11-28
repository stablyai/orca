import type { WorktreeLineage } from '../../worktree/lineage-types'
import type { Worktree } from '../../worktree/types'
import type { WorktreeWithInlineLineage } from '../../worktree/lineage/workspace-lineage-graph'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { getLineagePlacementRows } from './worktree-occurrence-plan'
import {
  getSidebarLineageParentsByIdentity,
  type SidebarLineageParentIdentities
} from './worktree-lineage-projection'

const rowsByWorktreeMapCache = new WeakMap<ReadonlyMap<string, Worktree>, Map<string, Worktree>>()

function getCachedRowsByWorktreeMap(
  worktreeMap: ReadonlyMap<string, Worktree>
): Map<string, Worktree> {
  const cached = rowsByWorktreeMapCache.get(worktreeMap)
  if (cached) {
    return cached
  }
  const rows = new Map<string, Worktree>()
  for (const worktree of worktreeMap.values()) {
    rows.set(getWorktreeHostIdentity(worktree), worktree)
  }
  rowsByWorktreeMapCache.set(worktreeMap, rows)
  return rows
}

function getSidebarLineageRowsByIdentityReadonly(
  worktrees: readonly Worktree[],
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderRows: readonly Worktree[]
): ReadonlyMap<string, Worktree> {
  const baseRows = getCachedRowsByWorktreeMap(worktreeMap)
  let rowsByIdentity: Map<string, Worktree> | undefined
  for (const worktree of worktrees) {
    const identity = getWorktreeHostIdentity(worktree)
    if (rowsByIdentity) {
      rowsByIdentity.set(identity, worktree)
    } else if (baseRows.get(identity) !== worktree) {
      rowsByIdentity = new Map(baseRows)
      rowsByIdentity.set(identity, worktree)
    }
  }
  if (folderRows.length > 0) {
    rowsByIdentity ??= new Map(baseRows)
    for (const worktree of folderRows) {
      rowsByIdentity.set(getWorktreeHostIdentity(worktree), worktree)
    }
  }
  return rowsByIdentity ?? baseRows
}

function hasAnyLineageSource(
  worktrees: readonly Worktree[],
  worktreeMap: ReadonlyMap<string, Worktree>,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  lineageParentIdentities?: SidebarLineageParentIdentities
): boolean {
  if (lineageParentIdentities && lineageParentIdentities.size > 0) {
    return true
  }
  for (const key in lineageById) {
    if (Object.hasOwn(lineageById, key)) {
      return true
    }
  }
  for (const worktree of worktrees) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read.
    if ((worktree as WorktreeWithInlineLineage).lineage) {
      return true
    }
  }
  for (const worktree of worktreeMap.values()) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read.
    if ((worktree as WorktreeWithInlineLineage).lineage) {
      return true
    }
  }
  return false
}

export function getSidebarLineageRowsByIdentity(
  worktrees: readonly Worktree[],
  worktreeMap: ReadonlyMap<string, Worktree>,
  folderRows: readonly Worktree[] = []
): Map<string, Worktree> {
  const rowsByIdentity = new Map(getCachedRowsByWorktreeMap(worktreeMap))
  for (const worktree of worktrees) {
    rowsByIdentity.set(getWorktreeHostIdentity(worktree), worktree)
  }
  for (const worktree of folderRows) {
    rowsByIdentity.set(getWorktreeHostIdentity(worktree), worktree)
  }
  return rowsByIdentity
}

/** Children by parent identity. Folder workspace rows parent only through resolved identities, and a
 * shown folder is never hidden by the project filter, which names repos. */
export function getSidebarLineageChildren(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = [],
  lineageParentIdentities?: SidebarLineageParentIdentities,
  folderRows: readonly Worktree[] = []
): Map<string, Worktree[]> {
  if (!hasAnyLineageSource(worktrees, worktreeMap, lineageById, lineageParentIdentities)) {
    return new Map<string, Worktree[]>()
  }
  const rowsByIdentity = getSidebarLineageRowsByIdentityReadonly(
    worktrees,
    worktreeMap,
    lineageParentIdentities ? folderRows : []
  )
  const parentByIdentity = getSidebarLineageParentsByIdentity(
    lineageById,
    rowsByIdentity,
    lineageParentIdentities
  )
  const childrenByParentIdentity = new Map<string, Worktree[]>()
  if (parentByIdentity.size === 0) {
    return childrenByParentIdentity
  }
  const allowedRepoIds = filterRepoIds.length > 0 ? new Set(filterRepoIds) : null
  let folderIdentities: Set<string> | null = null
  if (allowedRepoIds && folderRows.length > 0) {
    folderIdentities = new Set<string>()
    for (const folderRow of folderRows) {
      folderIdentities.add(getWorktreeHostIdentity(folderRow))
    }
  }
  for (const [childIdentity, child] of rowsByIdentity) {
    const parent = parentByIdentity.get(childIdentity)
    if (
      !parent ||
      (allowedRepoIds &&
        (!allowedRepoIds.has(child.repoId) ||
          (!allowedRepoIds.has(parent.repoId) &&
            !folderIdentities?.has(getWorktreeHostIdentity(parent)))))
    ) {
      continue
    }
    const identity = getWorktreeHostIdentity(parent)
    const children = childrenByParentIdentity.get(identity)
    if (children) {
      children.push(child)
    } else {
      childrenByParentIdentity.set(identity, [child])
    }
  }
  return childrenByParentIdentity
}

// Why: pin is placement of the clicked row. Descendants keep their own isPinned
// and still follow a visible pinned ancestor into the Pinned section.
export function getPinnedSectionWorktrees(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): Worktree[] {
  return getLineagePlacementRows({
    rows: worktrees,
    isPinned: (worktree) => worktree.isPinned === true,
    childrenByParentIdentity: getSidebarLineageChildren(
      worktrees,
      lineageById,
      worktreeMap,
      filterRepoIds
    ),
    identityOf: getWorktreeHostIdentity,
    duplicatePinned: false
  }).pinned
}

export function isPinnedSectionWorktree(
  worktree: Worktree,
  visibleWorktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  filterRepoIds: readonly string[] = []
): boolean {
  if (worktree.isPinned) {
    return true
  }
  const identity = getWorktreeHostIdentity(worktree)
  return getPinnedSectionWorktrees(visibleWorktrees, lineageById, worktreeMap, filterRepoIds).some(
    (candidate) => getWorktreeHostIdentity(candidate) === identity
  )
}
