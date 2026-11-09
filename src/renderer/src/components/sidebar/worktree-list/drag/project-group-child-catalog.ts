import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project-groups'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  compareCodePoints,
  compareSidebarText
} from '../../../../../../shared/sidebar-list/text-order'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'

export function parseChildItemId(
  itemId: ProjectGroupChildItemId
): { kind: 'group'; id: string } | { kind: 'repo'; id: string } {
  return itemId.startsWith('group:')
    ? { kind: 'group', id: itemId.slice('group:'.length) }
    : { kind: 'repo', id: itemId.slice('repo:'.length) }
}

export function findChildRepoForCatalogHost(
  repoId: string,
  ownerHostId: ExecutionHostId | null | undefined,
  repoById?: ReadonlyMap<string, Repo>,
  liveRepos?: readonly Repo[]
): Repo | undefined {
  if (ownerHostId && liveRepos) {
    const exactMatch = liveRepos.find(
      (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === ownerHostId
    )
    if (exactMatch) {
      return exactMatch
    }
  }
  const catalogHostId = getCatalogHostIdForExecutionHost(ownerHostId ?? undefined)
  if (catalogHostId && liveRepos) {
    const matched = liveRepos.find(
      (repo) =>
        repo.id === repoId &&
        getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === catalogHostId
    )
    if (matched) {
      return matched
    }
  }
  return repoById?.get(repoId) ?? liveRepos?.find((repo) => repo.id === repoId)
}

export function filterRepoHeaderIdsByCatalogHost(
  repoIds: readonly string[],
  ownerHostId: ExecutionHostId | null | undefined,
  liveRepos?: readonly Repo[],
  repoById?: ReadonlyMap<string, Repo>
): string[] {
  const catalogHostId = getCatalogHostIdForExecutionHost(ownerHostId ?? undefined)
  if (!catalogHostId || (!liveRepos && !repoById)) {
    return [...repoIds]
  }
  return repoIds.filter((repoId) => {
    const repo = findChildRepoForCatalogHost(repoId, ownerHostId, repoById, liveRepos)
    return !repo || getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === catalogHostId
  })
}

export function collectTargetProjectGroupSiblingIds(args: {
  draggedGroupId: string
  targetParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  seededSiblingIds: readonly string[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
}): string[] {
  const catalogHostId = getCatalogHostIdForExecutionHost(args.ownerHostId ?? undefined)
  const matchesHost = (groupId: string): boolean => {
    if (!catalogHostId) {
      return true
    }
    const candidate = args.projectGroupById.get(groupId)
    return (
      !candidate ||
      getCatalogHostIdForExecutionHost(getRepoExecutionHostId(candidate)) === catalogHostId
    )
  }
  const result = args.seededSiblingIds.filter(
    (groupId) => groupId !== args.draggedGroupId && matchesHost(groupId)
  )
  const seen = new Set(result)
  const hiddenSiblings = [...args.projectGroupById.values()]
    .filter((candidate) => {
      if (
        candidate.id === args.draggedGroupId ||
        seen.has(candidate.id) ||
        !matchesHost(candidate.id)
      ) {
        return false
      }
      return args.targetParentGroupId !== null
        ? candidate.parentGroupId === args.targetParentGroupId
        : !candidate.parentGroupId || !args.projectGroupById.has(candidate.parentGroupId)
    })
    .sort(
      (left, right) =>
        (right.isPinned ? 1 : 0) - (left.isPinned ? 1 : 0) ||
        left.tabOrder - right.tabOrder ||
        compareSidebarText(left.name, right.name) ||
        compareCodePoints(left.id, right.id)
    )
    .map((candidate) => candidate.id)
  return [...result, ...hiddenSiblings]
}

export function filterGroupChildItemIdsByCatalogHost(args: {
  itemIds: readonly ProjectGroupChildItemId[]
  ownerHostId: ExecutionHostId | null | undefined
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
}): ProjectGroupChildItemId[] {
  const catalogHostId = getCatalogHostIdForExecutionHost(args.ownerHostId ?? undefined)
  if (!catalogHostId) {
    return [...args.itemIds]
  }
  return args.itemIds.filter((itemId) => {
    const parsed = parseChildItemId(itemId)
    if (parsed.kind === 'group') {
      const group = args.projectGroupById?.get(parsed.id)
      return (
        !group || getCatalogHostIdForExecutionHost(getRepoExecutionHostId(group)) === catalogHostId
      )
    }
    const repo = findChildRepoForCatalogHost(
      parsed.id,
      args.ownerHostId,
      args.repoById,
      args.liveRepos
    )
    return !repo || getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === catalogHostId
  })
}

export function isGroupChildItemPinned(
  itemId: ProjectGroupChildItemId,
  projectGroupById?: ReadonlyMap<string, ProjectGroup>,
  pinnedRepoHeaderIds?: ReadonlySet<string>,
  repoById?: ReadonlyMap<string, Repo>,
  ownerHostId?: ExecutionHostId | null,
  liveRepos?: readonly Repo[]
): boolean {
  const parsed = parseChildItemId(itemId)
  if (parsed.kind === 'group') {
    return projectGroupById?.get(parsed.id)?.isPinned === true
  }
  if (pinnedRepoHeaderIds?.has(parsed.id)) {
    return true
  }
  const hostRepo = findChildRepoForCatalogHost(parsed.id, ownerHostId, repoById, liveRepos)
  return hostRepo
    ? hostRepo.isPinned === true
    : isRepoHeaderIdPinned(parsed.id, pinnedRepoHeaderIds, repoById)
}

export function collectCatalogProjectGroupChildItemIds(args: {
  parentGroupId: string
  ownerHostId?: ExecutionHostId | null
  seededItemIds: readonly ProjectGroupChildItemId[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  liveRepos?: readonly Repo[]
  pinnedRepoHeaderIds?: ReadonlySet<string>
  orderedRepoIds?: readonly string[]
}): ProjectGroupChildItemId[] {
  const result = filterGroupChildItemIdsByCatalogHost({
    itemIds: args.seededItemIds,
    ownerHostId: args.ownerHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  })
  const seen = new Set<ProjectGroupChildItemId>(result)
  const catalogHostId = getCatalogHostIdForExecutionHost(args.ownerHostId ?? undefined)
  const matchesHost = (hostId: ExecutionHostId | undefined): boolean =>
    !catalogHostId || getCatalogHostIdForExecutionHost(hostId) === catalogHostId
  const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds ?? [])
  const candidateRepos = args.liveRepos ?? (args.repoById ? [...args.repoById.values()] : [])
  let hasAnyExplicitRepoOrder = false
  for (const repo of candidateRepos) {
    if (
      repo.projectGroupId === args.parentGroupId &&
      matchesHost(getRepoExecutionHostId(repo)) &&
      typeof repo.projectGroupOrder === 'number' &&
      Number.isFinite(repo.projectGroupOrder)
    ) {
      hasAnyExplicitRepoOrder = true
      break
    }
  }
  const hiddenItems: {
    itemId: ProjectGroupChildItemId
    kind: 'group' | 'repo'
    isPinned: boolean
    rank: number
    label: string
    id: string
  }[] = []
  for (const group of args.projectGroupById.values()) {
    if (group.parentGroupId !== args.parentGroupId || !matchesHost(getRepoExecutionHostId(group))) {
      continue
    }
    const itemId: ProjectGroupChildItemId = `group:${group.id}`
    if (!seen.has(itemId)) {
      seen.add(itemId)
      hiddenItems.push({
        itemId,
        kind: 'group',
        isPinned: group.isPinned === true,
        rank: group.tabOrder,
        label: group.name,
        id: group.id
      })
    }
  }
  for (const repo of candidateRepos) {
    if (repo.projectGroupId !== args.parentGroupId || !matchesHost(getRepoExecutionHostId(repo))) {
      continue
    }
    const itemId: ProjectGroupChildItemId = `repo:${repo.id}`
    if (!seen.has(itemId)) {
      seen.add(itemId)
      hiddenItems.push({
        itemId,
        kind: 'repo',
        isPinned: isGroupChildItemPinned(
          itemId,
          args.projectGroupById,
          args.pinnedRepoHeaderIds,
          args.repoById,
          args.ownerHostId,
          args.liveRepos
        ),
        rank: getEffectiveProjectGroupManualRank(repo, repoOrderRankById),
        label: repo.displayName,
        id: repo.id
      })
    }
  }
  hiddenItems.sort((left, right) => {
    const byPin = (right.isPinned ? 1 : 0) - (left.isPinned ? 1 : 0)
    if (byPin !== 0) {
      return byPin
    }
    if (!hasAnyExplicitRepoOrder && left.kind !== right.kind) {
      return left.kind === 'repo' ? -1 : 1
    }
    if (left.rank !== right.rank) {
      return left.rank - right.rank
    }
    if (left.kind !== right.kind) {
      return left.kind === 'group' ? -1 : 1
    }
    return compareSidebarText(left.label, right.label) || compareCodePoints(left.id, right.id)
  })
  for (const entry of hiddenItems) {
    result.push(entry.itemId)
  }
  return result
}
