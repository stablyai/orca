import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { ProjectGroup } from '../../../shared/types'
import { getProjectGroupExecutionHostIdForRows } from '@/components/sidebar/worktree-list-host-filtering'

export type LocalProjectGroupCandidate = Pick<
  ProjectGroup,
  'id' | 'name' | 'parentPath' | 'connectionId' | 'executionHostId' | 'createdAt'
>

function isLocallyOwnedProjectGroup(group: LocalProjectGroupCandidate): boolean {
  return (
    getProjectGroupExecutionHostIdForRows(group, LOCAL_EXECUTION_HOST_ID) ===
    LOCAL_EXECUTION_HOST_ID
  )
}

// Why: the OS always hands over a local path; a remote-owned group must never claim it just because parentPath matches.
export function findLocalProjectGroupForFilePath(
  filePath: string,
  projectGroups: readonly LocalProjectGroupCandidate[]
): LocalProjectGroupCandidate | null {
  return (
    projectGroups.find(
      (group) =>
        group.parentPath &&
        relativePathInsideRoot(group.parentPath, filePath) !== null &&
        isLocallyOwnedProjectGroup(group)
    ) ?? null
  )
}

// Why: reuse a group this flow already created (orphaned by a failed/deleted workspace) instead of piling up
// identically-named duplicates; oldest createdAt is the one a user is most likely to recognize.
export function findLocalProjectGroupByName(
  name: string,
  projectGroups: readonly LocalProjectGroupCandidate[]
): LocalProjectGroupCandidate | null {
  let oldest: LocalProjectGroupCandidate | null = null
  for (const group of projectGroups) {
    if (group.name !== name || !isLocallyOwnedProjectGroup(group)) {
      continue
    }
    if (!oldest || group.createdAt < oldest.createdAt) {
      oldest = group
    }
  }
  return oldest
}

// Why: a folder-backed group the user set up wins over one this flow named itself — reuse only kicks in as a
// fallback once the path-based match misses.
export function findLocalProjectGroupForOsRequestedFile(
  filePath: string,
  groupName: string,
  projectGroups: readonly LocalProjectGroupCandidate[]
): LocalProjectGroupCandidate | null {
  return (
    findLocalProjectGroupForFilePath(filePath, projectGroups) ??
    findLocalProjectGroupByName(groupName, projectGroups)
  )
}
