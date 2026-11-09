import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { getEffectiveProjectGroupManualRank } from '../../../../../../shared/project/groups/project-groups'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  compareCodePoints,
  compareSidebarText
} from '../../../../../../shared/sidebar-list/sorting/text-order'
import {
  collectTargetProjectGroupSiblingIds,
  getCatalogHostIdForExecutionHost
} from './group-header-hit-geometry'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'

export { collectTargetProjectGroupSiblingIds }

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
  return parsed.kind === 'group'
    ? projectGroupById?.get(parsed.id)?.isPinned === true
    : isRepoHeaderIdPinned(parsed.id, pinnedRepoHeaderIds, repoById, ownerHostId, liveRepos)
}

type CatalogChildOrderEntry = {
  itemId: ProjectGroupChildItemId
  kind: 'group' | 'repo'
  isPinned: boolean
  rank: number
  label: string
  id: string
}

function compareCatalogChildOrderEntries(
  left: CatalogChildOrderEntry,
  right: CatalogChildOrderEntry,
  hasAnyExplicitRepoOrder: boolean
): number {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }
  if (!hasAnyExplicitRepoOrder && left.kind !== right.kind) {
    return left.kind === 'repo' ? -1 : 1
  }
  return (
    left.rank - right.rank ||
    (left.kind === right.kind ? 0 : left.kind === 'group' ? -1 : 1) ||
    compareSidebarText(left.label, right.label) ||
    compareCodePoints(left.id, right.id)
  )
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
  const seededIds = filterGroupChildItemIdsByCatalogHost({
    itemIds: args.seededItemIds,
    ownerHostId: args.ownerHostId,
    projectGroupById: args.projectGroupById,
    repoById: args.repoById,
    liveRepos: args.liveRepos
  })
  const seen = new Set<ProjectGroupChildItemId>(seededIds)
  const catalogHostId = getCatalogHostIdForExecutionHost(args.ownerHostId ?? undefined)
  const matchesHost = (hostId: ExecutionHostId | undefined): boolean =>
    !catalogHostId || getCatalogHostIdForExecutionHost(hostId) === catalogHostId
  const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds ?? [])
  const candidateRepos = args.liveRepos ?? (args.repoById ? [...args.repoById.values()] : [])
  const hasAnyExplicitRepoOrder = candidateRepos.some(
    (repo) =>
      repo.projectGroupId === args.parentGroupId &&
      matchesHost(getRepoExecutionHostId(repo)) &&
      typeof repo.projectGroupOrder === 'number' &&
      Number.isFinite(repo.projectGroupOrder)
  )
  const toOrderEntry = (
    itemId: ProjectGroupChildItemId,
    fallbackIndex?: number
  ): CatalogChildOrderEntry => {
    const parsed = parseChildItemId(itemId)
    if (parsed.kind === 'group') {
      const group = args.projectGroupById.get(parsed.id)
      return {
        itemId,
        kind: 'group',
        isPinned: group?.isPinned === true,
        rank: group?.tabOrder ?? fallbackIndex ?? 0,
        label: group?.name ?? parsed.id,
        id: parsed.id
      }
    }
    const repo = findChildRepoForCatalogHost(
      parsed.id,
      args.ownerHostId,
      args.repoById,
      args.liveRepos
    )
    return {
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
      rank: repo
        ? getEffectiveProjectGroupManualRank(repo, repoOrderRankById, fallbackIndex)
        : (fallbackIndex ?? 0),
      label: repo?.displayName ?? parsed.id,
      id: parsed.id
    }
  }
  const hiddenItems: CatalogChildOrderEntry[] = []
  for (const group of args.projectGroupById.values()) {
    const itemId: ProjectGroupChildItemId = `group:${group.id}`
    if (
      group.parentGroupId === args.parentGroupId &&
      matchesHost(getRepoExecutionHostId(group)) &&
      !seen.has(itemId)
    ) {
      seen.add(itemId)
      hiddenItems.push(toOrderEntry(itemId))
    }
  }
  for (const repo of candidateRepos) {
    const itemId: ProjectGroupChildItemId = `repo:${repo.id}`
    if (
      repo.projectGroupId === args.parentGroupId &&
      matchesHost(getRepoExecutionHostId(repo)) &&
      !seen.has(itemId)
    ) {
      seen.add(itemId)
      hiddenItems.push(toOrderEntry(itemId))
    }
  }
  if (hiddenItems.length === 0) {
    return seededIds
  }
  const seededEntries = seededIds.map((itemId, index) => toOrderEntry(itemId, index))
  hiddenItems.sort((left, right) =>
    compareCatalogChildOrderEntries(left, right, hasAnyExplicitRepoOrder)
  )
  const merged: ProjectGroupChildItemId[] = []
  let s = 0
  let h = 0
  while (s < seededEntries.length && h < hiddenItems.length) {
    if (
      compareCatalogChildOrderEntries(hiddenItems[h], seededEntries[s], hasAnyExplicitRepoOrder) < 0
    ) {
      merged.push(hiddenItems[h].itemId)
      h += 1
    } else {
      merged.push(seededEntries[s].itemId)
      s += 1
    }
  }
  merged.push(
    ...seededEntries.slice(s).map((entry) => entry.itemId),
    ...hiddenItems.slice(h).map((entry) => entry.itemId)
  )
  return merged
}
