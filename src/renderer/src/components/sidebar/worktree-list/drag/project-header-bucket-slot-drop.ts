import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project/groups/project-groups'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import { getNextRootProjectOrder } from '../../../../../../shared/sidebar-list/sections/root-project-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import {
  filterBucketByPinTier,
  isRepoHeaderIdPinned,
  reindexBucketRectsByHeaderIds,
  resolveCrossBucketPinnedPrefixSlot
} from './header-drag-pin-tier'
import {
  filterRepoHeaderIdsByCatalogHost,
  findChildRepoForCatalogHost
} from './project-group-child-catalog'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import { computeStrictChildSingleRank } from './project-group-opposite-pin-tier-order'
import {
  computeProjectHeaderDropPreview,
  type ProjectHeaderDragBucketKey,
  type ProjectHeaderDragRect
} from './project-header-drop'
import type { ProjectHeaderDropTarget } from './project-header-group-drop'
import {
  resolveEmptyGroupInteriorSlot,
  resolveEmptyUngroupedRootSlot
} from './project-header-subgroup-exit-drop'

function resolveRepoOnlyBucketSlot(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  targetBucketKey: ProjectHeaderDragBucketKey
  isCrossBucket: boolean
  draggedRepoPinned?: boolean
  dragHostId?: ExecutionHostId | null
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  enclosingGroupBottom?: number
  allBucketHeaderIds: readonly string[]
  allBucketRects: readonly ProjectHeaderDragRect[]
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const hostBucketRects = reindexBucketRectsByHeaderIds(
    args.allBucketHeaderIds,
    args.allBucketRects,
    (rect) => rect.repoId
  )
  const hasPinFilter =
    args.pinnedRepoHeaderIds !== undefined ||
    args.repoById !== undefined ||
    args.liveRepos !== undefined ||
    args.draggedRepoPinned !== undefined
  const { tierHeaderIds: bucketHeaderIds, tierRects: bucketRects } = hasPinFilter
    ? filterBucketByPinTier({
        allHeaderIds: args.allBucketHeaderIds,
        allRects: hostBucketRects,
        getId: (rect) => rect.repoId,
        isIdPinned: (id) =>
          isRepoHeaderIdPinned(
            id,
            args.pinnedRepoHeaderIds,
            args.repoById,
            args.dragHostId,
            args.liveRepos
          ),
        targetPinned: args.isCrossBucket ? false : Boolean(args.draggedRepoPinned)
      })
    : { tierHeaderIds: [...args.allBucketHeaderIds], tierRects: hostBucketRects }

  if (args.isCrossBucket && bucketHeaderIds.length === 0) {
    const pinnedOnlySlot = resolveCrossBucketPinnedPrefixSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      contentBottom: args.contentBottom,
      enclosingGroupBottom: args.enclosingGroupBottom,
      allBucketHeaderCount: args.allBucketHeaderIds.length,
      allBucketRects: hostBucketRects,
      tierHeaderCount: 0,
      tierRects: bucketRects
    })
    return pinnedOnlySlot
      ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...pinnedOnlySlot }
      : null
  }

  const preview =
    computeProjectHeaderDropPreview({
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      rects: bucketRects,
      sidebarRepoHeaderIds: bucketHeaderIds,
      contentBottom: args.contentBottom
    }) ??
    (args.isCrossBucket
      ? resolveCrossBucketPinnedPrefixSlot({
          localY: args.localY,
          scrollTop: args.scrollTop,
          contentBottom: args.contentBottom,
          enclosingGroupBottom: args.enclosingGroupBottom,
          allBucketHeaderCount: args.allBucketHeaderIds.length,
          allBucketRects: hostBucketRects,
          tierHeaderCount: bucketHeaderIds.length,
          tierRects: bucketRects
        })
      : null)
  return preview ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...preview } : null
}

export function resolveNonInterleavedRepoBucketSlot(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  dragHostId?: ExecutionHostId
  currentGroupId: string | null
  targetBucketKey: ProjectHeaderDragBucketKey
  isCrossBucket: boolean
  hasEmptyRootDropZone: boolean
  draggedRepoPinned?: boolean
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  enclosingGroup: ProjectGroupHeaderDragRect | undefined
  joinableGroupIds: ReadonlySet<string>
  hostSectionBounds: { top: number; bottom: number } | null
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const allBucketHeaderIds = filterRepoHeaderIdsByCatalogHost(
    args.sidebarRepoHeaderIdsByBucket.get(args.targetBucketKey) ?? [],
    args.dragHostId,
    args.liveRepos,
    args.repoById
  )
  const allBucketRects = args.repoHeaderRects.filter(
    (rect) =>
      rect.bucketKey === args.targetBucketKey &&
      (!args.hostSectionBounds ||
        (rect.top >= args.hostSectionBounds.top && rect.top < args.hostSectionBounds.bottom))
  )
  if (
    args.enclosingGroup &&
    (allBucketHeaderIds.length === 0 ||
      (args.hostSectionBounds !== null && allBucketRects.length === 0))
  ) {
    return resolveEmptyGroupInteriorSlot({
      enclosingGroup: args.enclosingGroup,
      currentGroupId: args.currentGroupId,
      scrollTop: args.scrollTop
    })
  }
  if (
    args.targetBucketKey === 'ungrouped' &&
    (allBucketHeaderIds.length === 0 ||
      (args.hostSectionBounds !== null && allBucketRects.length === 0))
  ) {
    return resolveEmptyUngroupedRootSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      currentGroupId: args.currentGroupId,
      joinableGroupIds: args.joinableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      hostSectionBounds: args.hostSectionBounds,
      hostSectionBottom: args.hostSectionBounds?.bottom
    })
  }
  const slot = resolveRepoOnlyBucketSlot({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    localY: args.localY,
    targetBucketKey: args.targetBucketKey,
    isCrossBucket: args.isCrossBucket,
    draggedRepoPinned: args.draggedRepoPinned,
    dragHostId: args.dragHostId,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    repoById: args.repoById,
    liveRepos: args.liveRepos,
    enclosingGroupBottom: args.enclosingGroup?.bottom,
    allBucketHeaderIds,
    allBucketRects,
    contentBottom: args.contentBottom
  })
  if (slot || args.targetBucketKey !== 'ungrouped' || !args.hasEmptyRootDropZone) {
    return slot
  }
  const hostBucketRects = reindexBucketRectsByHeaderIds(
    allBucketHeaderIds,
    allBucketRects,
    (rect) => rect.repoId
  )
  const lastPinnedRect = hostBucketRects.at(-1)
  if (
    !lastPinnedRect ||
    lastPinnedRect.headerIndex !== allBucketHeaderIds.length - 1 ||
    args.localY <= Math.max(lastPinnedRect.bottom, lastPinnedRect.sectionBottom ?? 0)
  ) {
    return null
  }
  return resolveEmptyUngroupedRootSlot({
    localY: args.localY,
    scrollTop: args.scrollTop,
    currentGroupId: args.currentGroupId,
    joinableGroupIds: args.joinableGroupIds,
    groupHeaderRects: args.groupHeaderRects,
    hostSectionBounds: args.hostSectionBounds,
    hostSectionBottom: args.hostSectionBounds?.bottom
  })
}

export function computeCrossBucketProjectGroupMutations(args: {
  draggedGroupRepo: Repo
  targetBucketHeaderIds: readonly string[]
  targetGroupId: string | null
  dropIndex: number
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById: ReadonlyMap<string, Repo>
  liveRepos: readonly Repo[]
  orderedRepoIds: readonly string[]
  projectGroups?: readonly ProjectGroup[]
}): { kind: 'repo'; repo: Repo; projectGroupId: string | null; order: number }[] {
  const dragHostId = getRepoExecutionHostId(args.draggedGroupRepo)
  const catalogHostId = getCatalogHostIdForExecutionHost(dragHostId)
  const targetHeaderIds = filterRepoHeaderIdsByCatalogHost(
    args.targetBucketHeaderIds,
    dragHostId,
    args.liveRepos,
    args.repoById
  )
  const siblings = targetHeaderIds
    .filter(
      (repoId) =>
        repoId !== args.draggedGroupRepo.id &&
        !isRepoHeaderIdPinned(
          repoId,
          args.pinnedRepoHeaderIds,
          args.repoById,
          dragHostId,
          args.liveRepos
        )
    )
    .map((repoId) => findChildRepoForCatalogHost(repoId, dragHostId, args.repoById, args.liveRepos))
    .filter((repo): repo is Repo => repo !== undefined)
  const clampedDropIndex = Math.max(0, Math.min(siblings.length, args.dropIndex))
  const matchesHost = (hostId: ReturnType<typeof getRepoExecutionHostId>): boolean =>
    !catalogHostId || getCatalogHostIdForExecutionHost(hostId) === catalogHostId
  if (args.targetGroupId === null && siblings.length === 0 && args.projectGroups) {
    const nextOrder =
      getNextRootProjectOrder(
        args.liveRepos.filter((repo) => matchesHost(getRepoExecutionHostId(repo))),
        args.projectGroups.filter((group) => matchesHost(getRepoExecutionHostId(group)))
      ) ?? 0
    return [{ kind: 'repo', repo: args.draggedGroupRepo, projectGroupId: null, order: nextOrder }]
  }
  const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
  const siblingRanks = siblings.map((repo, index) =>
    getEffectiveProjectGroupManualRank(repo, repoOrderRankById, index)
  )
  const singleRank = computeStrictChildSingleRank(siblingRanks, clampedDropIndex, false)
  if (singleRank !== undefined) {
    return [
      {
        kind: 'repo',
        repo: args.draggedGroupRepo,
        projectGroupId: args.targetGroupId,
        order: singleRank
      }
    ]
  }
  const reordered = siblings.slice()
  reordered.splice(clampedDropIndex, 0, args.draggedGroupRepo)
  const primaryOrder = clampedDropIndex
  const mutations: { kind: 'repo'; repo: Repo; projectGroupId: string | null; order: number }[] = [
    {
      kind: 'repo',
      repo: args.draggedGroupRepo,
      projectGroupId: args.targetGroupId,
      order: primaryOrder
    }
  ]
  for (const [index, repo] of reordered.entries()) {
    if (repo !== args.draggedGroupRepo && repo.projectGroupOrder !== index) {
      mutations.push({ kind: 'repo', repo, projectGroupId: args.targetGroupId, order: index })
    }
  }
  return mutations
}
