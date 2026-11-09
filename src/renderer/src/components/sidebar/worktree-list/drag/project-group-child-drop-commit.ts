import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project/groups/project-groups'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  collectCatalogProjectGroupChildItemIds,
  collectTargetProjectGroupSiblingIds,
  filterGroupChildItemIdsByCatalogHost,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
} from './project-group-child-catalog'
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import {
  collectChildIndexMutations,
  collectOppositePinTierOrderPreservationMutations,
  computeStrictChildSingleRank,
  resolveCatalogChildTierDrop
} from './project-group-opposite-pin-tier-order'
import type {
  ProjectGroupChildItemId,
  ProjectGroupChildMutation
} from './project-group-child-slot-order'

export function computeAppendedProjectGroupTabOrder(args: {
  groupId: string
  parentGroupId: string | null
  ownerHostId?: ExecutionHostId | null
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  orderedRepoIds?: readonly string[]
}): number {
  if (args.parentGroupId) {
    const childIds = collectCatalogProjectGroupChildItemIds({
      parentGroupId: args.parentGroupId,
      ownerHostId: args.ownerHostId,
      seededItemIds: args.sidebarGroupChildItemIdsByGroupId?.get(args.parentGroupId) ?? [],
      projectGroupById: args.projectGroupById,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      orderedRepoIds: args.orderedRepoIds
    }).filter((itemId) => itemId !== `group:${args.groupId}`)
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds ?? [])
    const maxSiblingOrder = childIds.reduce((maxOrder, itemId, index) => {
      const parsed = parseChildItemId(itemId)
      if (parsed.kind === 'group') {
        return Math.max(maxOrder, args.projectGroupById.get(parsed.id)?.tabOrder ?? 0)
      }
      const repo = findChildRepoForCatalogHost(
        parsed.id,
        args.ownerHostId,
        args.repoById,
        args.liveRepos
      )
      const rank = repo ? getEffectiveProjectGroupManualRank(repo, repoOrderRankById, index) : 0
      return Math.max(maxOrder, rank)
    }, -1)
    return maxSiblingOrder + 1
  }

  const targetBucketKey: ProjectGroupHeaderDragBucketKey = args.parentGroupId
    ? `parent:${args.parentGroupId}`
    : 'root'
  const siblingIds = collectTargetProjectGroupSiblingIds({
    draggedGroupId: args.groupId,
    targetParentGroupId: args.parentGroupId,
    ownerHostId: args.ownerHostId,
    seededSiblingIds: args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    projectGroupById: args.projectGroupById
  })
  const maxSiblingTabOrder = siblingIds.reduce((maxOrder, id) => {
    const order = args.projectGroupById.get(id)?.tabOrder ?? 0
    return Math.max(maxOrder, order)
  }, -1)
  return maxSiblingTabOrder + 1
}

export function computeProjectGroupChildDropMutations(args: {
  parentGroupId: string
  draggedItem:
    | { kind: 'group'; group: ProjectGroup }
    | { kind: 'repo'; repo: Repo; headerRepoId?: string }
  isCrossBucket: boolean
  dropIndex: number | 'append'
  dragHostId?: ExecutionHostId
  allChildItemIds: readonly ProjectGroupChildItemId[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  orderedRepoIds?: readonly string[]
}): ProjectGroupChildMutation[] {
  const hasHeaderAlias =
    args.draggedItem.kind === 'repo' &&
    args.draggedItem.headerRepoId !== undefined &&
    args.draggedItem.headerRepoId !== args.draggedItem.repo.id &&
    !args.allChildItemIds.includes(`repo:${args.draggedItem.repo.id}`) &&
    args.allChildItemIds.includes(`repo:${args.draggedItem.headerRepoId}`)
  const draggedItemId: ProjectGroupChildItemId =
    args.draggedItem.kind === 'group'
      ? `group:${args.draggedItem.group.id}`
      : hasHeaderAlias
        ? `repo:${args.draggedItem.headerRepoId}`
        : `repo:${args.draggedItem.repo.id}`
  const draggedAliasId =
    hasHeaderAlias && args.draggedItem.kind === 'repo'
      ? (`repo:${args.draggedItem.repo.id}` as const)
      : undefined

  const effectiveDragHostId =
    args.dragHostId ??
    (args.draggedItem.kind === 'group'
      ? getRepoExecutionHostId(args.draggedItem.group)
      : getRepoExecutionHostId(args.draggedItem.repo))
  const targetPinned = args.isCrossBucket
    ? false
    : args.draggedItem.kind === 'group'
      ? args.draggedItem.group.isPinned === true
      : isGroupChildItemPinned(
          draggedItemId,
          args.projectGroupById,
          args.pinnedRepoHeaderIds,
          args.repoById,
          effectiveDragHostId,
          args.liveRepos
        ) || args.draggedItem.repo.isPinned === true
  const matchesTargetPinTier = (id: ProjectGroupChildItemId): boolean =>
    id !== draggedAliasId &&
    isGroupChildItemPinned(
      id,
      args.projectGroupById,
      args.pinnedRepoHeaderIds,
      args.repoById,
      effectiveDragHostId,
      args.liveRepos
    ) === targetPinned
  const visibleTierIds = filterGroupChildItemIdsByCatalogHost({
    itemIds: args.allChildItemIds,
    ownerHostId: effectiveDragHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  }).filter(matchesTargetPinTier)
  const catalogTierIds = collectCatalogProjectGroupChildItemIds({
    parentGroupId: args.parentGroupId,
    ownerHostId: effectiveDragHostId,
    seededItemIds: args.allChildItemIds,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    orderedRepoIds: args.orderedRepoIds
  }).filter(matchesTargetPinTier)

  const resolvedDrop = resolveCatalogChildTierDrop({
    draggedItemId,
    isCrossBucket: args.isCrossBucket,
    dropIndex: args.dropIndex,
    visibleTierIds,
    catalogTierIds
  })
  if (!resolvedDrop) {
    return []
  }
  const { siblingIds, siblingDropIndex } = resolvedDrop

  const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds ?? [])
  const siblingRanks = siblingIds.map((id, index) => {
    const parsed = parseChildItemId(id)
    if (parsed.kind === 'group') {
      return args.projectGroupById.get(parsed.id)?.tabOrder
    }
    const repo = findChildRepoForCatalogHost(
      parsed.id,
      effectiveDragHostId,
      args.repoById,
      args.liveRepos
    )
    return repo ? getEffectiveProjectGroupManualRank(repo, repoOrderRankById, index) : undefined
  })

  const singleRank = computeStrictChildSingleRank(
    siblingRanks,
    siblingDropIndex,
    args.dropIndex === 'append'
  )

  const groupReparentPatch =
    args.draggedItem.kind === 'group' && args.isCrossBucket
      ? {
          parentGroupId: args.parentGroupId,
          ...(args.draggedItem.group.rootProjectOrder !== undefined
            ? { rootProjectOrder: null }
            : {})
        }
      : undefined

  const mixesGroupsAndRepos =
    args.draggedItem.kind === 'group' || siblingIds.some((id) => id.startsWith('group:'))
  const hasLegacyUnrankedSiblingRepo =
    mixesGroupsAndRepos &&
    siblingIds.some((id) => {
      const parsed = parseChildItemId(id)
      if (parsed.kind !== 'repo') {
        return false
      }
      const repo = findChildRepoForCatalogHost(
        parsed.id,
        effectiveDragHostId,
        args.repoById,
        args.liveRepos
      )
      return (
        repo !== undefined &&
        (typeof repo.projectGroupOrder !== 'number' || !Number.isFinite(repo.projectGroupOrder))
      )
    })

  const withOppositeTierPreservation = (
    mutations: ProjectGroupChildMutation[]
  ): ProjectGroupChildMutation[] =>
    mutations.some((mutation) => mutation.kind === 'repo')
      ? [
          ...mutations,
          ...collectOppositePinTierOrderPreservationMutations({
            parentGroupId: args.parentGroupId,
            targetPinned,
            draggedItemId,
            dragHostId: effectiveDragHostId,
            allChildItemIds: args.allChildItemIds,
            projectGroupById: args.projectGroupById,
            repoById: args.repoById,
            liveRepos: args.liveRepos,
            pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
            orderedRepoIds: args.orderedRepoIds
          })
        ]
      : mutations

  if (singleRank !== undefined && !hasLegacyUnrankedSiblingRepo) {
    if (args.draggedItem.kind === 'group') {
      return [
        {
          kind: 'group',
          groupId: args.draggedItem.group.id,
          updates: {
            ...groupReparentPatch,
            tabOrder: singleRank
          }
        }
      ]
    }
    return withOppositeTierPreservation([
      {
        kind: 'repo',
        repo: args.draggedItem.repo,
        projectGroupId: args.parentGroupId,
        order: singleRank
      }
    ])
  }

  const reorderedIds = siblingIds.slice()
  reorderedIds.splice(siblingDropIndex, 0, draggedItemId)
  return withOppositeTierPreservation(
    collectChildIndexMutations({
      itemIds: reorderedIds,
      parentGroupId: args.parentGroupId,
      dragHostId: effectiveDragHostId,
      projectGroupById: args.projectGroupById,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      draggedItem: {
        itemId: draggedItemId,
        item: args.draggedItem,
        groupReparentPatch
      }
    })
  )
}
