import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../../../shared/resolved-worktree-lineage'
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
