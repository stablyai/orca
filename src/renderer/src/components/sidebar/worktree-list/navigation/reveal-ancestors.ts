import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { PINNED_GROUP_KEY, getProjectGroupHeaderKey } from '../grouping/group-keys'
import {
  buildMergedProjectGroupIndex,
  buildProjectGroupHostIndex,
  findMergedProjectGroupByRowId,
  findProjectGroupByHost,
  resolveMergedProjectGroupId
} from '../grouping/cross-host-project-group-merge'
import { getProjectGroupHostId } from '../../../../store/slices/project-group-owner-routing'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroupingModel } from '../grouping/project-grouping'

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

/** `hostId` scopes the whole walk: parentGroupId names a group on the owning host,
 *  and group ids are only unique per host. */
function getProjectGroupAncestorKeys(
  projectGroupId: string | null | undefined,
  projectGroups: readonly ProjectGroup[],
  hostId?: ExecutionHostId
): string[] {
  const groupHostIndex = buildProjectGroupHostIndex(projectGroups)
  const mergedIndex = buildMergedProjectGroupIndex(projectGroups)
  const keys: string[] = []
  const seen = new Set<string>()
  let currentGroupId = projectGroupId ?? null
  while (currentGroupId && !seen.has(currentGroupId)) {
    const group = findProjectGroupByHost(groupHostIndex, currentGroupId, hostId)
    if (!group) {
      break
    }
    seen.add(currentGroupId)
    // Why: reveal must expand the merged header the row renders under (#22022).
    keys.unshift(
      getProjectGroupHeaderKey(
        resolveMergedProjectGroupId(mergedIndex, group.id, getProjectGroupHostId(group))
      )
    )
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
    // Why the merged row: a rendered row key carries no host, so only the row it
    // was built from can say which host's parent chain to walk.
    const rowId = args.rowKey.slice('project-group:'.length)
    const primary = findMergedProjectGroupByRowId(
      buildMergedProjectGroupIndex(args.projectGroups),
      rowId
    )?.primary
    return getProjectGroupAncestorKeys(
      primary?.parentGroupId,
      args.projectGroups,
      primary ? getProjectGroupHostId(primary) : undefined
    )
  }
  const keys = new Set<string>()
  for (const repoId of getRepoIdsFromHeaderRowKey(
    args.rowKey,
    args.repoMap,
    args.projectGrouping
  )) {
    const repo = args.repoMap.get(repoId)
    const repoHostId =
      repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : undefined
    for (const key of getProjectGroupAncestorKeys(
      repo?.projectGroupId,
      args.projectGroups,
      repoHostId
    )) {
      keys.add(key)
    }
  }
  return [...keys]
}

export function getPinnedWorktreeRevealCollapsedGroupKeys({
  worktree,
  collapsedGroups,
  inPinnedSection = worktree.isPinned
}: {
  worktree: Worktree
  collapsedGroups: ReadonlySet<string>
  inPinnedSection?: boolean
}): string[] {
  if (!inPinnedSection) {
    return []
  }
  const keys: string[] = []
  // Why: the reveal effect already opens this host; re-returning it would toggle it back closed.
  if (collapsedGroups.has(PINNED_GROUP_KEY)) {
    keys.push(PINNED_GROUP_KEY)
  }
  return keys
}
