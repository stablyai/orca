import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  collectCatalogProjectGroupChildItemIds,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
} from './project-group-child-catalog'
import { mapSidebarProjectGroupDropIndexToSiblingInsertIndex } from './project-group-header-drop'
import type {
  ProjectGroupChildItemId,
  ProjectGroupChildMutation
} from './project-group-child-slot-order'

export function resolveCatalogChildTierDrop(args: {
  draggedItemId: ProjectGroupChildItemId
  isCrossBucket: boolean
  dropIndex: number | 'append'
  visibleTierIds: readonly ProjectGroupChildItemId[]
  catalogTierIds: readonly ProjectGroupChildItemId[]
}): { siblingIds: ProjectGroupChildItemId[]; siblingDropIndex: number } | null {
  const siblingIds = args.catalogTierIds.filter((id) => id !== args.draggedItemId)
  if (args.dropIndex === 'append') {
    if (!args.isCrossBucket) {
      const catalogSourceIndex = args.catalogTierIds.indexOf(args.draggedItemId)
      if (catalogSourceIndex === -1 || catalogSourceIndex === siblingIds.length) {
        return null
      }
    }
    return { siblingIds, siblingDropIndex: siblingIds.length }
  }

  const visibleSiblingIds = args.visibleTierIds.filter((id) => id !== args.draggedItemId)
  let visibleInsertIndex: number
  if (!args.isCrossBucket) {
    const sourceIndex = args.visibleTierIds.indexOf(args.draggedItemId)
    if (sourceIndex === -1) {
      return null
    }
    visibleInsertIndex = mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
      sidebarDropIndex: args.dropIndex,
      sourceIndex,
      siblingCount: visibleSiblingIds.length
    })
    if (visibleInsertIndex === Math.min(sourceIndex, visibleSiblingIds.length)) {
      return null
    }
  } else {
    visibleInsertIndex = Math.max(0, Math.min(visibleSiblingIds.length, args.dropIndex))
  }

  if (visibleInsertIndex < visibleSiblingIds.length) {
    const anchorIndex = siblingIds.indexOf(visibleSiblingIds[visibleInsertIndex])
    return {
      siblingIds,
      siblingDropIndex:
        anchorIndex === -1 ? Math.min(siblingIds.length, visibleInsertIndex) : anchorIndex
    }
  }
  const lastVisibleId = visibleSiblingIds.at(-1)
  if (lastVisibleId !== undefined) {
    const lastVisibleIndex = siblingIds.indexOf(lastVisibleId)
    return {
      siblingIds,
      siblingDropIndex: lastVisibleIndex === -1 ? siblingIds.length : lastVisibleIndex + 1
    }
  }
  return { siblingIds, siblingDropIndex: Math.max(0, Math.min(siblingIds.length, args.dropIndex)) }
}

export function computeStrictChildSingleRank(
  siblingRanks: readonly (number | undefined)[],
  siblingDropIndex: number,
  isAppend: boolean
): number | undefined {
  const before = siblingRanks[siblingDropIndex - 1]
  const after = siblingRanks[siblingDropIndex]
  if (before === undefined && after === undefined) {
    return 0
  }
  if (before === undefined) {
    if (after !== undefined && Number.isFinite(after)) {
      const candidate = after - 1
      if (Number.isFinite(candidate) && candidate < after) {
        return candidate
      }
    }
    return undefined
  }
  if (after === undefined) {
    if (!Number.isFinite(before)) {
      return undefined
    }
    const maxSiblingRank = isAppend
      ? siblingRanks.reduce<number>(
          (max, rank) => (rank !== undefined && Number.isFinite(rank) ? Math.max(max, rank) : max),
          before
        )
      : before
    const candidate = maxSiblingRank + 1
    return Number.isFinite(candidate) && candidate > maxSiblingRank ? candidate : undefined
  }
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) {
    const candidate = before + (after - before) / 2
    if (Number.isFinite(candidate) && candidate > before && candidate < after) {
      return candidate
    }
  }
  return undefined
}

export function collectOppositePinTierOrderPreservationMutations(args: {
  parentGroupId: string
  targetPinned: boolean
  draggedItemId: ProjectGroupChildItemId
  dragHostId?: ExecutionHostId
  allChildItemIds: readonly ProjectGroupChildItemId[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  orderedRepoIds?: readonly string[]
}): ProjectGroupChildMutation[] {
  const otherPinned = !args.targetPinned
  const isOtherTier = (itemId: ProjectGroupChildItemId): boolean =>
    itemId !== args.draggedItemId &&
    isGroupChildItemPinned(
      itemId,
      args.projectGroupById,
      args.pinnedRepoHeaderIds,
      args.repoById,
      args.dragHostId,
      args.liveRepos
    ) === otherPinned

  const otherTierIds = collectCatalogProjectGroupChildItemIds({
    parentGroupId: args.parentGroupId,
    ownerHostId: args.dragHostId,
    seededItemIds: args.allChildItemIds,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    orderedRepoIds: args.orderedRepoIds
  }).filter(isOtherTier)

  const hasGroup = otherTierIds.some((id) => id.startsWith('group:'))
  const hasLegacyUnrankedRepo =
    hasGroup &&
    otherTierIds.some((id) => {
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
  if (!hasLegacyUnrankedRepo) {
    return []
  }

  return collectChildIndexMutations({
    itemIds: otherTierIds,
    parentGroupId: args.parentGroupId,
    dragHostId: args.dragHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  })
}

export function collectChildIndexMutations(args: {
  itemIds: readonly ProjectGroupChildItemId[]
  parentGroupId: string
  dragHostId?: ExecutionHostId
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  draggedItem?: {
    itemId: ProjectGroupChildItemId
    item: { kind: 'group'; group: ProjectGroup } | { kind: 'repo'; repo: Repo }
    groupReparentPatch?: Pick<
      Extract<ProjectGroupChildMutation, { kind: 'group' }>['updates'],
      'parentGroupId' | 'rootProjectOrder'
    >
  }
}): ProjectGroupChildMutation[] {
  const mutations: ProjectGroupChildMutation[] = []
  for (const [index, itemId] of args.itemIds.entries()) {
    if (args.draggedItem && itemId === args.draggedItem.itemId) {
      if (args.draggedItem.item.kind === 'group') {
        mutations.push({
          kind: 'group',
          groupId: args.draggedItem.item.group.id,
          updates: { ...args.draggedItem.groupReparentPatch, tabOrder: index }
        })
      } else {
        mutations.push({
          kind: 'repo',
          repo: args.draggedItem.item.repo,
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
