import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project-groups'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { Repo } from '../../../../../../shared/repo-types'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import {
  collectCatalogProjectGroupChildItemIds,
  filterGroupChildItemIdsByCatalogHost,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
} from './project-group-child-catalog'
import {
  mapSidebarProjectGroupDropIndexToSiblingInsertIndex,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import { filterProjectGroupIdsByCatalogHost } from './project-group-nested-exit-drop'
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
  const siblingIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    args.ownerHostId,
    args.projectGroupById
  ).filter((id) => id !== args.groupId)
  const maxSiblingTabOrder = siblingIds.reduce((maxOrder, id) => {
    const order = args.projectGroupById.get(id)?.tabOrder ?? 0
    return Math.max(maxOrder, order)
  }, -1)
  return maxSiblingTabOrder + 1
}

export function computeProjectGroupChildDropMutations(args: {
  parentGroupId: string
  draggedItem: { kind: 'group'; group: ProjectGroup } | { kind: 'repo'; repo: Repo }
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
  const draggedItemId: ProjectGroupChildItemId =
    args.draggedItem.kind === 'group'
      ? `group:${args.draggedItem.group.id}`
      : `repo:${args.draggedItem.repo.id}`

  const hostScopedIds =
    args.dropIndex === 'append'
      ? collectCatalogProjectGroupChildItemIds({
          parentGroupId: args.parentGroupId,
          ownerHostId: args.dragHostId,
          seededItemIds: args.allChildItemIds,
          projectGroupById: args.projectGroupById,
          repoById: args.repoById,
          liveRepos: args.liveRepos,
          pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
          orderedRepoIds: args.orderedRepoIds
        })
      : filterGroupChildItemIdsByCatalogHost({
          itemIds: args.allChildItemIds,
          ownerHostId: args.dragHostId,
          projectGroupById: args.projectGroupById,
          repoById: args.repoById,
          liveRepos: args.liveRepos
        })
  const targetPinned = args.isCrossBucket
    ? false
    : args.draggedItem.kind === 'group'
      ? args.draggedItem.group.isPinned === true
      : isRepoHeaderIdPinned(args.draggedItem.repo.id, args.pinnedRepoHeaderIds, args.repoById) ||
        args.draggedItem.repo.isPinned === true

  const tierIds = hostScopedIds.filter(
    (id) =>
      isGroupChildItemPinned(
        id,
        args.projectGroupById,
        args.pinnedRepoHeaderIds,
        args.repoById,
        args.dragHostId,
        args.liveRepos
      ) === targetPinned
  )

  const siblingIds = tierIds.filter((id) => id !== draggedItemId)
  let siblingDropIndex: number
  if (!args.isCrossBucket) {
    const sourceIndex = tierIds.indexOf(draggedItemId)
    if (sourceIndex === -1) {
      return []
    }
    const rawDrop = args.dropIndex === 'append' ? siblingIds.length : args.dropIndex
    siblingDropIndex = mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
      sidebarDropIndex: rawDrop,
      sourceIndex,
      siblingCount: siblingIds.length
    })
    if (siblingDropIndex === Math.min(sourceIndex, siblingIds.length)) {
      return []
    }
  } else {
    siblingDropIndex =
      args.dropIndex === 'append'
        ? siblingIds.length
        : Math.max(0, Math.min(siblingIds.length, args.dropIndex))
  }

  const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds ?? [])
  const siblingRanks = siblingIds.map((id, index) => {
    const parsed = parseChildItemId(id)
    if (parsed.kind === 'group') {
      return args.projectGroupById.get(parsed.id)?.tabOrder
    }
    const repo = findChildRepoForCatalogHost(
      parsed.id,
      args.dragHostId,
      args.repoById,
      args.liveRepos
    )
    return repo ? getEffectiveProjectGroupManualRank(repo, repoOrderRankById, index) : undefined
  })

  const before = siblingRanks[siblingDropIndex - 1]
  const after = siblingRanks[siblingDropIndex]
  let singleRank: number | undefined
  if (before === undefined && after === undefined) {
    singleRank = 0
  } else if (before === undefined) {
    singleRank = after !== undefined ? after - 1 : 0
  } else if (after === undefined) {
    const maxSiblingRank =
      args.dropIndex === 'append'
        ? siblingRanks.reduce<number>(
            (max, rank) =>
              rank !== undefined && Number.isFinite(rank) ? Math.max(max, rank) : max,
            before
          )
        : before
    singleRank = maxSiblingRank + 1
  } else if (after > before) {
    singleRank = before + (after - before) / 2
  }

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
        args.dragHostId,
        args.repoById,
        args.liveRepos
      )
      return (
        repo !== undefined &&
        (typeof repo.projectGroupOrder !== 'number' || !Number.isFinite(repo.projectGroupOrder))
      )
    })

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
    return [
      {
        kind: 'repo',
        repo: args.draggedItem.repo,
        projectGroupId: args.parentGroupId,
        order: singleRank
      }
    ]
  }

  const reorderedIds = siblingIds.slice()
  reorderedIds.splice(siblingDropIndex, 0, draggedItemId)
  const mutations: ProjectGroupChildMutation[] = []
  for (const [index, itemId] of reorderedIds.entries()) {
    if (itemId === draggedItemId) {
      if (args.draggedItem.kind === 'group') {
        mutations.push({
          kind: 'group',
          groupId: args.draggedItem.group.id,
          updates: {
            ...groupReparentPatch,
            tabOrder: index
          }
        })
      } else {
        mutations.push({
          kind: 'repo',
          repo: args.draggedItem.repo,
          projectGroupId: args.parentGroupId,
          order: index
        })
      }
      continue
    }
    const parsed = parseChildItemId(itemId)
    if (parsed.kind === 'group') {
      const siblingGroup = args.projectGroupById.get(parsed.id)
      if (siblingGroup && siblingGroup.tabOrder !== index) {
        mutations.push({ kind: 'group', groupId: siblingGroup.id, updates: { tabOrder: index } })
      }
      continue
    }
    const siblingRepo = findChildRepoForCatalogHost(
      parsed.id,
      args.dragHostId,
      args.repoById,
      args.liveRepos
    )
    if (siblingRepo && siblingRepo.projectGroupOrder !== index) {
      mutations.push({
        kind: 'repo',
        repo: siblingRepo,
        projectGroupId: args.parentGroupId,
        order: index
      })
    }
  }
  return mutations
}
