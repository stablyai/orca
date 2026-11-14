import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { getEffectiveProjectGroupManualRank } from './project-groups'
import { getLogicalRepoOrderRankById } from './project-section-order'
import { compareCodePoints, compareSidebarText } from './sidebar-list/sorting/text-order'

export type RootProjectEntry = { kind: 'group'; group: ProjectGroup } | { kind: 'repo'; repo: Repo }

export function getRootProjectEntryKey(entry: RootProjectEntry): string {
  return entry.kind === 'group' ? `group:${entry.group.id}` : `repo:${entry.repo.id}`
}

export function getRootProjectEntryRank(
  entry: RootProjectEntry,
  repoOrder?: ReadonlyMap<string, number>
): number {
  return entry.kind === 'group'
    ? (entry.group.rootProjectOrder ?? Number.NEGATIVE_INFINITY)
    : getEffectiveProjectGroupManualRank(entry.repo, repoOrder)
}

export function compareRootProjectEntries(
  left: RootProjectEntry,
  right: RootProjectEntry,
  repoOrder?: ReadonlyMap<string, number>
): number {
  const leftRank = getRootProjectEntryRank(left, repoOrder)
  const rightRank = getRootProjectEntryRank(right, repoOrder)
  if (leftRank === rightRank) {
    return left.kind === 'group' && right.kind === 'group'
      ? left.group.tabOrder - right.group.tabOrder ||
          compareSidebarText(left.group.name, right.group.name) ||
          compareCodePoints(left.group.executionHostId ?? '', right.group.executionHostId ?? '') ||
          compareCodePoints(left.group.id, right.group.id)
      : 0
  }
  return leftRank < rightRank ? -1 : 1
}

export function getNextRootProjectOrder(
  repos: readonly Repo[],
  groups: readonly ProjectGroup[]
): number | undefined {
  if (!groups.some((group) => group.rootProjectOrder !== undefined)) {
    return undefined
  }
  const groupIds = new Set(groups.map((group) => group.id))
  const repoOrder = getLogicalRepoOrderRankById(repos.map((repo) => repo.id))
  let maximum = -1000
  for (const group of groups) {
    if (!group.parentGroupId || !groupIds.has(group.parentGroupId)) {
      maximum = Math.max(maximum, group.rootProjectOrder ?? -1000)
    }
  }
  for (const repo of repos) {
    if (!repo.projectGroupId || !groupIds.has(repo.projectGroupId)) {
      maximum = Math.max(maximum, getEffectiveProjectGroupManualRank(repo, repoOrder))
    }
  }
  return maximum + 1000
}
