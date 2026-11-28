import {
  getCyclicWorktreeLineageChildIds,
  isValidResolvedWorktreeLineageEdge
} from '../../worktree/lineage/resolved-worktree-lineage'
import type { ExecutionHostId } from '../../execution-host/execution-host'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../../worktree/lineage-types'
import type { FolderLineageRecordOf } from '../../worktree/lineage/folder-lineage-parents'
import type { CrossStoreLineageView } from '../../worktree/lineage/cross-store-lineage-resolution'
import {
  getProjectedWorktreeLineage,
  getSameStoreLineageParent,
  resolveWorkspaceLineageParents,
  type WorktreeWithInlineLineage
} from '../../worktree/lineage/workspace-lineage-graph'
import type { Worktree } from '../../worktree/types'

export type LineageRenderInfo =
  | { state: 'none' }
  | { state: 'valid'; lineage: WorktreeLineage; parent: Worktree }
  | { state: 'missing'; lineage: WorktreeLineage }

const NO_LINEAGE_RENDER_INFO: LineageRenderInfo = Object.freeze({ state: 'none' })
const EMPTY_PARENT_IDENTITIES: SidebarLineageParentIdentities = new Map()
const EMPTY_PARENT_BY_IDENTITY: ReadonlyMap<string, Worktree> = new Map()

type LineageProjection = {
  cyclicLineageIds?: Set<string>
  childrenByParentId?: Map<string, Worktree[]>
  sidebarParentByIdentity?: ReadonlyMap<string, Worktree>
  sidebarParentByIdentityByResolution?: WeakMap<
    SidebarLineageParentIdentities,
    ReadonlyMap<string, Worktree>
  >
}

/** Repeated O(worktrees) projections cache by both immutable input identities. Weak keys avoid retaining replaced store collections. */
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
  let validLineageByChildId: Map<string, WorktreeLineage> | undefined
  for (const worktree of worktreeMap.values()) {
    const lineage = getProjectedWorktreeLineage(worktree, lineageById)
    if (!lineage) {
      continue
    }
    const parent = worktreeMap.get(lineage.parentWorktreeId)
    if (parent && isValidResolvedWorktreeLineageEdge(worktree, parent, lineage)) {
      ;(validLineageByChildId ??= new Map<string, WorktreeLineage>()).set(worktree.id, lineage)
    }
  }
  const cyclicLineageIds = validLineageByChildId
    ? getCyclicWorktreeLineageChildIds(validLineageByChildId)
    : new Set<string>()
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
    return NO_LINEAGE_RENDER_INFO
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

/** Narrow to the target host before the id-keyed projection can collapse cross-host collisions. */
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
    const inline = (worktree as WorktreeWithInlineLineage).lineage
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

/** Child host identity → parent host identity, resolved once over every visible store's complete rows. */
export type SidebarLineageParentIdentities = ReadonlyMap<string, string>

/** Same-store edges merged with cross-store records (a valid same-store edge wins), cycles dropped.
 * Pass every visible store's unfiltered rows: a filtered-out twin must still make a parent ambiguous. */
export function resolveSidebarLineageParentIdentities(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  completeRowsByHostIdentity: ReadonlyMap<string, Worktree>,
  crossStoreLineage: CrossStoreLineageView | undefined,
  folderRecordOf?: FolderLineageRecordOf
): SidebarLineageParentIdentities {
  const resolved = resolveWorkspaceLineageParents(
    lineageById,
    completeRowsByHostIdentity,
    crossStoreLineage,
    folderRecordOf
  )
  if (resolved.size === 0) {
    return EMPTY_PARENT_IDENTITIES
  }
  const parentIdentities = new Map<string, string>()
  for (const [identity, parent] of resolved) {
    parentIdentities.set(identity, getWorktreeHostIdentity(parent))
  }
  return parentIdentities
}

/** Host-keyed nesting parents; cycles have none. With resolved identities, only rows present here nest.
 * Cache assumes callers replace inputs rather than mutate them. */
export function getSidebarLineageParentsByIdentity(
  lineageById: Readonly<Record<string, WorktreeLineage>>,
  rowsByHostIdentity: ReadonlyMap<string, Worktree>,
  parentIdentities?: SidebarLineageParentIdentities
): ReadonlyMap<string, Worktree> {
  const projection = getLineageProjection(lineageById, rowsByHostIdentity)
  const cached = parentIdentities
    ? projection.sidebarParentByIdentityByResolution?.get(parentIdentities)
    : projection.sidebarParentByIdentity
  if (cached) {
    return cached
  }
  if (!parentIdentities) {
    const parentByIdentity = resolveWorkspaceLineageParents(lineageById, rowsByHostIdentity)
    projection.sidebarParentByIdentity = parentByIdentity
    return parentByIdentity
  }
  if (parentIdentities.size === 0 || rowsByHostIdentity.size === 0) {
    projection.sidebarParentByIdentityByResolution ??= new WeakMap()
    projection.sidebarParentByIdentityByResolution.set(parentIdentities, EMPTY_PARENT_BY_IDENTITY)
    return EMPTY_PARENT_BY_IDENTITY
  }
  let parentByIdentity: Map<string, Worktree> | undefined
  if (parentIdentities.size <= rowsByHostIdentity.size) {
    for (const [identity, parentIdentity] of parentIdentities) {
      if (!rowsByHostIdentity.has(identity)) {
        continue
      }
      const parent = rowsByHostIdentity.get(parentIdentity)
      if (parent) {
        ;(parentByIdentity ??= new Map<string, Worktree>()).set(identity, parent)
      }
    }
  } else {
    for (const identity of rowsByHostIdentity.keys()) {
      const parentIdentity = parentIdentities.get(identity)
      const parent =
        parentIdentity === undefined ? undefined : rowsByHostIdentity.get(parentIdentity)
      if (parent) {
        ;(parentByIdentity ??= new Map<string, Worktree>()).set(identity, parent)
      }
    }
  }
  const result: ReadonlyMap<string, Worktree> = parentByIdentity ?? EMPTY_PARENT_BY_IDENTITY
  projection.sidebarParentByIdentityByResolution ??= new WeakMap()
  projection.sidebarParentByIdentityByResolution.set(parentIdentities, result)
  return result
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
    const parent = getSameStoreLineageParent(current, lineageById, rowsByHostIdentity)
    if (!parent || seen.has(getWorktreeHostIdentity(parent))) {
      break
    }
    seen.add(getWorktreeHostIdentity(parent))
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}
