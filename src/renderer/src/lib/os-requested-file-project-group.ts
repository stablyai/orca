import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { ProjectGroup } from '../../../shared/types'
import { getProjectGroupExecutionHostIdForRows } from '@/components/sidebar/worktree-list-host-filtering'

export type LocalProjectGroupCandidate = Pick<
  ProjectGroup,
  'id' | 'parentPath' | 'connectionId' | 'executionHostId'
>

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
        getProjectGroupExecutionHostIdForRows(group, LOCAL_EXECUTION_HOST_ID) ===
          LOCAL_EXECUTION_HOST_ID
    ) ?? null
  )
}
