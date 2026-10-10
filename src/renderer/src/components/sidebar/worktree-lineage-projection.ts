import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../../../shared/resolved-worktree-lineage'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

type WorktreeWithResolvedLineage = Worktree & { lineage?: WorktreeLineage | null }

export function getProjectedWorktreeLineage(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>
): WorktreeLineage | null | undefined {
  if (Object.hasOwn(lineageById, worktree.id)) {
    return lineageById[worktree.id]
  }
  return (worktree as WorktreeWithResolvedLineage).lineage
}

type LineageProjection = {
  cyclicLineageIds?: Set<string>
  childrenByParentId?: Map<string, Worktree[]>
}

/**
 * Why: both projections are O(worktrees) scans that the sidebar row builder and
 * the pinned/attached-children readers re-run several times per pass, and
 * zustand re-runs those on every store write. Both are pure in the two inputs,
 * and both inputs are immutable store-derived collections that are REPLACED
 * rather than mutated, so their identity pair is a sound cache key. Weak on both
 * levels so a superseded lineage record or worktree index is not pinned.
 */
const projectionByLineageAndWorktreeMap = new WeakMap<
  Readonly<Record<string, WorktreeLineage>>,
  WeakMap<ReadonlyMap<string, Worktree>, LineageProjection>
>()

function getLineageProjection(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): LineageProjection {
  let byWorktreeMap = projectionByLineageAndWorktreeMap.get(lineageById)
  if (!byWorktreeMap) {
    byWorktreeMap = new WeakMap()
    projectionByLineageAndWorktreeMap.set(lineageById, byWorktreeMap)
  }
  let projection = byWorktreeMap.get(worktreeMap)
  if (!projection) {
    projection = {}
    byWorktreeMap.set(worktreeMap, projection)
  }
  return projection
}

export function getCyclicProjectedWorktreeLineageIds(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Set<string> {
  const projection = getLineageProjection(lineageById, worktreeMap)
  if (projection.cyclicLineageIds) {
    return projection.cyclicLineageIds
  }
  const validLineageByChildId = new Map<string, WorktreeLineage>()
  for (const worktree of worktreeMap.values()) {
    const lineage = getProjectedWorktreeLineage(worktree, lineageById)
    if (!lineage) {
      continue
    }
    const parent = worktreeMap.get(lineage.parentWorktreeId)
    if (parent && isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)) {
      validLineageByChildId.set(worktree.id, lineage)
    }
  }
  const cyclicLineageIds = getCyclicWorktreeLineageChildIds(validLineageByChildId)
  projection.cyclicLineageIds = cyclicLineageIds
  return cyclicLineageIds
}

export function getLineageRenderInfo(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): LineageRenderInfo {
  const lineage = getProjectedWorktreeLineage(worktree, lineageById)
  if (!lineage) {
    return { state: 'none' }
  }
  const parent = worktreeMap.get(lineage.parentWorktreeId)
  if (
    cyclicLineageIds.has(worktree.id) ||
    !parent ||
    !isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)
  ) {
    return { state: 'missing', lineage }
  }
  return { state: 'valid', lineage, parent }
}

export function getProjectedWorktreeLineageChildrenByParentId(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Map<string, Worktree[]> {
  const projection = getLineageProjection(lineageById, worktreeMap)
  if (projection.childrenByParentId) {
    return projection.childrenByParentId
  }
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const childrenByParentId = new Map<string, Worktree[]>()
  for (const worktree of worktreeMap.values()) {
    const lineage = getLineageRenderInfo(worktree, lineageById, worktreeMap, cyclicLineageIds)
    if (lineage.state !== 'valid') {
      continue
    }
    const children = childrenByParentId.get(lineage.parent.id) ?? []
    children.push(worktree)
    childrenByParentId.set(lineage.parent.id, children)
  }
  projection.childrenByParentId = childrenByParentId
  return childrenByParentId
}

/**
 * Lineage inputs for one execution host. Why: the id-keyed projection keeps one
 * row per id, so a two-host id collision must be narrowed to the target's host.
 */
export function getHostScopedWorktreeLineageInputs(
  worktrees: readonly Worktree[],
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  executionHostId: ExecutionHostId | undefined
): { worktreeMap: Map<string, Worktree>; lineageById: Record<string, WorktreeLineage> } {
  const worktreeMap = new Map<string, Worktree>()
  const hostLineageById: Record<string, WorktreeLineage> = {}
  for (const worktree of worktrees) {
    if (executionHostId && worktree.hostId && worktree.hostId !== executionHostId) {
      continue
    }
    worktreeMap.set(worktree.id, worktree)
    const projected = lineageById[worktree.id]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read, never trusted over a matching projection.
    const inline = (worktree as WorktreeWithResolvedLineage).lineage
    const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
    if (lineage) {
      hostLineageById[worktree.id] = lineage
    }
  }
  return { worktreeMap, lineageById: hostLineageById }
}

export function getWorktreeLineageAncestors(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  worktreeMap: ReadonlyMap<string, Worktree>
): Worktree[] {
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const ancestors: Worktree[] = []
  const seen = new Set<string>()
  let current: Worktree | undefined = worktree
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const lineage = getLineageRenderInfo(current, lineageById, worktreeMap, cyclicLineageIds)
    if (lineage.state !== 'valid') {
      break
    }
    ancestors.push(lineage.parent)
    current = lineage.parent
  }
  return ancestors
}

/**
 * The row a worktree nests under in the sidebar: its lineage parent on the worktree's own host,
 * where a row with no host id (older metadata) nests only under a parent with none either.
 */
export function getSidebarLineageParent(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>
): Worktree | undefined {
  const projected = getProjectedWorktreeLineage(worktree, lineageById)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolved rows may carry an inline lineage the Worktree type omits; it is only read, never trusted over a matching projection.
  const inline = (worktree as WorktreeWithResolvedLineage).lineage
  const lineage = projected?.worktreeInstanceId === worktree.instanceId ? projected : inline
  if (!lineage) {
    return undefined
  }
  const parent = rowsByHostIdentity.get(
    composeWorktreeHostIdentity(worktree.hostId, lineage.parentWorktreeId)
  )
  return parent && isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)
    ? parent
    : undefined
}

/** The rows a worktree nests under in the sidebar, nearest first; a lineage cycle nests nothing. */
export function getSidebarLineageAncestors(
  worktree: Worktree,
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  cyclicLineageIds: ReadonlySet<string>
): Worktree[] {
  const ancestors: Worktree[] = []
  const seen = new Set([getWorktreeHostIdentity(worktree)])
  let current = worktree
  while (!cyclicLineageIds.has(current.id)) {
    const parent = getSidebarLineageParent(current, lineageById, rowsByHostIdentity)
    if (!parent || seen.has(getWorktreeHostIdentity(parent))) {
      break
    }
    seen.add(getWorktreeHostIdentity(parent))
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}
