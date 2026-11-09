import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  collectCatalogProjectGroupChildItemIds,
  filterGroupChildItemIdsByCatalogHost,
  findChildRepoForCatalogHost,
  isGroupChildItemPinned,
  parseChildItemId
} from './project-group-child-catalog'
import type {
  ProjectGroupChildItemId,
  ProjectGroupChildMutation
} from './project-group-child-slot-order'

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

  const catalogOtherTierIds = collectCatalogProjectGroupChildItemIds({
    parentGroupId: args.parentGroupId,
    ownerHostId: args.dragHostId,
    seededItemIds: [],
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    orderedRepoIds: args.orderedRepoIds
  }).filter(isOtherTier)

  const seededOtherTierIds = filterGroupChildItemIdsByCatalogHost({
    itemIds: args.allChildItemIds,
    ownerHostId: args.dragHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  }).filter(isOtherTier)

  const seededSet = new Set(seededOtherTierIds)
  const otherTierIds =
    seededOtherTierIds.length === catalogOtherTierIds.length &&
    catalogOtherTierIds.every((id) => seededSet.has(id))
      ? seededOtherTierIds
      : [
          ...catalogOtherTierIds,
          ...seededOtherTierIds.filter((id) => !catalogOtherTierIds.includes(id))
        ]

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

  const mutations: ProjectGroupChildMutation[] = []
  for (const [index, itemId] of otherTierIds.entries()) {
    const parsed = parseChildItemId(itemId)
    if (parsed.kind === 'group') {
      const group = args.projectGroupById.get(parsed.id)
      if (group && group.tabOrder !== index) {
        mutations.push({ kind: 'group', groupId: group.id, updates: { tabOrder: index } })
      }
      continue
    }
    const repo = findChildRepoForCatalogHost(
      parsed.id,
      args.dragHostId,
      args.repoById,
      args.liveRepos
    )
    if (repo && repo.projectGroupOrder !== index) {
      mutations.push({ kind: 'repo', repo, projectGroupId: args.parentGroupId, order: index })
    }
  }
  return mutations
}
