import type { ProjectGroup } from '../../../../shared/project-group-types'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import { getRuntimeTargetHostId } from '../runtime-target-host'

export function projectGroupWithFetchedOwner(
  projectGroup: ProjectGroup,
  target: RuntimeClientTarget
): ProjectGroup {
  if (target.kind === 'environment') {
    return { ...projectGroup, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (projectGroup.connectionId) {
    return { ...projectGroup, executionHostId: toSshExecutionHostId(projectGroup.connectionId) }
  }
  return { ...projectGroup, executionHostId: LOCAL_EXECUTION_HOST_ID }
}
