import { getRepoExecutionHostId } from '../../execution-host/execution-host'
import type { Repo } from '../../repository/repo-types'
import { getLogicalRepoOrderRankById } from '../../sidebar-list/sections/project-section-order'
import { compareCodePoints, compareSidebarText } from '../../sidebar-list/sorting/text-order'
import type { ProjectGroup } from './project-group-types'
import { getEffectiveProjectGroupManualRank, getNextProjectGroupOrder } from './project-groups'

/** Snapshot legacy repo/subgroup order onto explicit ranks before the first ranked repo enters the group. */
export function initializeLegacyGroupChildOrdersForRepoMove(
  repos: Repo[],
  projectGroups: ProjectGroup[] | undefined,
  movedRepo: Repo,
  groupId: string | null
): boolean {
  if (groupId === null || !projectGroups || projectGroups.length === 0) {
    return false
  }
  const ownerHostId = getRepoExecutionHostId(movedRepo)
  const siblingRepos = repos.filter(
    (candidate) =>
      candidate !== movedRepo &&
      (candidate.projectGroupId ?? null) === groupId &&
      getRepoExecutionHostId(candidate) === ownerHostId
  )
  if (
    siblingRepos.length === 0 ||
    siblingRepos.some(
      (candidate) =>
        typeof candidate.projectGroupOrder === 'number' &&
        Number.isFinite(candidate.projectGroupOrder)
    )
  ) {
    return false
  }
  const childGroups = projectGroups.filter(
    (group) =>
      (group.parentGroupId ?? null) === groupId && getRepoExecutionHostId(group) === ownerHostId
  )
  if (childGroups.length === 0) {
    return false
  }
  const repoOrderRankById = getLogicalRepoOrderRankById(repos.map((repo) => repo.id))
  const hasTierInversion = (pinned: boolean): boolean => {
    let maxRepoRank = Number.NEGATIVE_INFINITY
    for (const repo of siblingRepos) {
      if ((repo.isPinned === true) === pinned) {
        maxRepoRank = Math.max(
          maxRepoRank,
          getEffectiveProjectGroupManualRank(repo, repoOrderRankById)
        )
      }
    }
    if (!Number.isFinite(maxRepoRank)) {
      return false
    }
    for (const group of childGroups) {
      if ((group.isPinned === true) === pinned) {
        const order = Number.isFinite(group.tabOrder) ? group.tabOrder : 0
        if (order <= maxRepoRank) {
          return true
        }
      }
    }
    return false
  }
  if (!hasTierInversion(true) && !hasTierInversion(false)) {
    return false
  }
  const compareRepos = (left: Repo, right: Repo): number => {
    const rankDelta =
      getEffectiveProjectGroupManualRank(left, repoOrderRankById) -
      getEffectiveProjectGroupManualRank(right, repoOrderRankById)
    if (rankDelta !== 0) {
      return rankDelta
    }
    const leftLabel = left.displayName || left.path
    const rightLabel = right.displayName || right.path
    return compareSidebarText(leftLabel, rightLabel) || compareCodePoints(left.id, right.id)
  }
  const compareGroups = (left: ProjectGroup, right: ProjectGroup): number => {
    const leftOrder = Number.isFinite(left.tabOrder) ? left.tabOrder : 0
    const rightOrder = Number.isFinite(right.tabOrder) ? right.tabOrder : 0
    return (
      leftOrder - rightOrder ||
      compareSidebarText(left.name, right.name) ||
      compareCodePoints(left.id, right.id)
    )
  }
  const ordered: ({ kind: 'repo'; item: Repo } | { kind: 'group'; item: ProjectGroup })[] = [
    ...siblingRepos
      .filter((repo) => repo.isPinned === true)
      .sort(compareRepos)
      .map((item) => ({ kind: 'repo' as const, item })),
    ...childGroups
      .filter((group) => group.isPinned === true)
      .sort(compareGroups)
      .map((item) => ({ kind: 'group' as const, item })),
    ...siblingRepos
      .filter((repo) => repo.isPinned !== true)
      .sort(compareRepos)
      .map((item) => ({ kind: 'repo' as const, item })),
    ...childGroups
      .filter((group) => group.isPinned !== true)
      .sort(compareGroups)
      .map((item) => ({ kind: 'group' as const, item }))
  ]
  const now = Date.now()
  let updatedGroups = false
  ordered.forEach((entry, index) => {
    if (entry.kind === 'group') {
      if (entry.item.tabOrder !== index) {
        entry.item.tabOrder = index
        entry.item.updatedAt = now
        updatedGroups = true
      }
      return
    }
    entry.item.projectGroupOrder = index
  })
  return updatedGroups
}

export function assignMoveProjectGroupOrder(
  repos: Repo[],
  projectGroups: ProjectGroup[] | undefined,
  movedRepo: Repo,
  groupId: string | null,
  explicitOrder?: number
): boolean {
  if (typeof explicitOrder === 'number' && Number.isFinite(explicitOrder)) {
    movedRepo.projectGroupOrder = explicitOrder
    return false
  }
  const updatedGroups = initializeLegacyGroupChildOrdersForRepoMove(
    repos,
    projectGroups,
    movedRepo,
    groupId
  )
  movedRepo.projectGroupOrder = getNextProjectGroupOrder(repos, groupId, projectGroups, {
    excludeRepo: movedRepo
  })
  return updatedGroups
}
