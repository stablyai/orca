import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from './execution-host'
import type { ProjectGroup, Repo } from './types'

export function getProjectGroupExecutionHostId(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
): string {
  if (group.executionHostId) {
    return group.executionHostId
  }
  return group.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function canMoveProjectToGroup(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
): boolean {
  return getRepoExecutionHostId(repo) === getProjectGroupExecutionHostId(group)
}

export function getProjectGroupMoveTargets<
  TGroup extends Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
>(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined,
  groups: readonly TGroup[]
): TGroup[] {
  if (!repo) {
    return []
  }
  const repoHostId = getRepoExecutionHostId(repo)
  return groups.filter((group) => getProjectGroupExecutionHostId(group) === repoHostId)
}
