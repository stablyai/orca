import {
  getAutomationProjectGroups,
  type AutomationProjectGroup
} from '@/components/automations/automation-project-groups'
import { searchRepos } from '@/lib/repo-search'
import type { Repo } from '../../../../../../shared/repo-types'

export type SidebarProjectFilterGroup = AutomationProjectGroup

// Why: one project can have a checkout per host; the filter lists the project once.
export function getSidebarProjectFilterGroups(repos: readonly Repo[]): SidebarProjectFilterGroup[] {
  return getAutomationProjectGroups(repos, '')
}

export function isSidebarProjectGroupSelected(
  group: SidebarProjectFilterGroup,
  selectedRepoIds: ReadonlySet<string>
): boolean {
  return group.sources.some((source) => selectedRepoIds.has(source.id))
}

export function addSidebarProjectGroup(
  filterRepoIds: readonly string[],
  group: SidebarProjectFilterGroup
): string[] {
  const next = [...filterRepoIds]
  for (const source of group.sources) {
    if (!next.includes(source.id)) {
      next.push(source.id)
    }
  }
  return next
}

export function removeSidebarProjectGroup(
  filterRepoIds: readonly string[],
  group: SidebarProjectFilterGroup
): string[] {
  const sourceIds = new Set(group.sources.map((source) => source.id))
  return filterRepoIds.filter((id) => !sourceIds.has(id))
}

export function searchSidebarProjectGroups(
  groups: readonly SidebarProjectFilterGroup[],
  query: string
): SidebarProjectFilterGroup[] {
  const groupByRepoId = new Map<string, SidebarProjectFilterGroup>()
  for (const group of groups) {
    for (const source of group.sources) {
      groupByRepoId.set(source.id, group)
    }
  }
  const matches: SidebarProjectFilterGroup[] = []
  const seen = new Set<string>()
  for (const repo of searchRepos(
    groups.flatMap((group) => group.sources),
    query
  )) {
    const group = groupByRepoId.get(repo.id)
    if (group && !seen.has(group.projectKey)) {
      seen.add(group.projectKey)
      matches.push(group)
    }
  }
  return matches
}
