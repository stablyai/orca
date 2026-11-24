import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getProjectGroupHeaderKey,
  PROJECTS_SECTION_GROUP_KEY
} from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { ProjectGroupingModel } from '../../../../../../shared/sidebar-list/sections/project-section-grouping'

function getProjectIdFromHeaderRowKey(rowKey: string): string | null {
  if (!rowKey.startsWith('project:')) {
    return null
  }
  const withoutPrefix = rowKey.slice('project:'.length)
  const setupSeparator = withoutPrefix.indexOf('::setup:')
  return setupSeparator === -1 ? withoutPrefix : withoutPrefix.slice(0, setupSeparator)
}

function getRepoIdsFromHeaderRowKey(
  rowKey: string,
  repoMap: Map<string, Repo>,
  projectGrouping?: ProjectGroupingModel
): string[] {
  if (rowKey.startsWith('repo:')) {
    return [rowKey.slice('repo:'.length)]
  }
  const setupMarker = '::setup:'
  const setupIndex = rowKey.indexOf(setupMarker)
  if (rowKey.startsWith('project:') && setupIndex !== -1) {
    return [rowKey.slice(setupIndex + setupMarker.length)]
  }
  const projectId = getProjectIdFromHeaderRowKey(rowKey)
  if (!projectId) {
    return []
  }
  const repoIds = new Set<string>()
  for (const setup of projectGrouping?.projectHostSetups ?? []) {
    if (setup.projectId === projectId && repoMap.has(setup.repoId)) {
      repoIds.add(setup.repoId)
    }
  }
  const project = projectGrouping?.projects.find((candidate) => candidate.id === projectId)
  for (const repoId of project?.sourceRepoIds ?? []) {
    if (repoMap.has(repoId)) {
      repoIds.add(repoId)
    }
  }
  return [...repoIds]
}

function getProjectGroupAncestorKeys(
  projectGroupId: string | null | undefined,
  projectGroups: readonly ProjectGroup[]
): string[] {
  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const keys: string[] = []
  const seen = new Set<string>()
  let currentGroupId = projectGroupId ?? null
  while (currentGroupId && !seen.has(currentGroupId)) {
    const group = groupsById.get(currentGroupId)
    if (!group) {
      break
    }
    seen.add(currentGroupId)
    keys.unshift(getProjectGroupHeaderKey(group.id))
    currentGroupId = group.parentGroupId
  }
  return keys
}

export function getSidebarRowRevealAncestorKeys(args: {
  rowKey: string
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
}): string[] {
  if (args.rowKey.startsWith('project-group:')) {
    const groupId = args.rowKey.slice('project-group:'.length)
    // Why the last copy: same-id host copies render as that one (getDistinctProjectGroups).
    const group = args.projectGroups.findLast((candidate) => candidate.id === groupId)
    return getProjectGroupAncestorKeys(group?.parentGroupId, args.projectGroups)
  }
  const keys = new Set<string>()
  for (const repoId of getRepoIdsFromHeaderRowKey(
    args.rowKey,
    args.repoMap,
    args.projectGrouping
  )) {
    const repo = args.repoMap.get(repoId)
    for (const key of getProjectGroupAncestorKeys(repo?.projectGroupId, args.projectGroups)) {
      keys.add(key)
    }
  }
  return [...keys]
}

/** A found row lives in the Projects list, so a folded Projects section is its outermost collapsed
 * ancestor: unfold it the same way, and let the reveal rerun with real geometry. True when it toggled. */
export function unfoldProjectsSectionForReveal(args: {
  collapsedGroups: ReadonlySet<string>
  toggleGroup: (key: string) => void
}): boolean {
  if (!args.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY)) {
    return false
  }
  args.toggleGroup(PROJECTS_SECTION_GROUP_KEY)
  return true
}
