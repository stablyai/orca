import type { AutomationHostTarget } from './automation-host-client'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'

function getRuntimeTargetHostId(target: AutomationHostTarget | null | undefined): string | null {
  return target?.kind === 'environment'
    ? `runtime:${encodeURIComponent(target.environmentId)}`
    : null
}

export function setupHostMatchesRunContext(
  setup: ProjectHostSetup,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  const targetHostId = getRuntimeTargetHostId(target)
  if (targetHostId) {
    if (setup.hostId !== targetHostId) {
      return false
    }
    const executionHostId = setup.executionHostId ?? setup.hostId
    const physicalHostId =
      executionHostId === targetHostId && setup.connectionId?.trim()
        ? toSshExecutionHostId(setup.connectionId.trim())
        : executionHostId
    return (
      physicalHostId === runHostId || (physicalHostId === targetHostId && runHostId === 'local')
    )
  }
  return setup.hostId === runHostId
}

export function repoHostMatchesRunContext(
  repo: Repo,
  runHostId: string,
  target: AutomationHostTarget | null | undefined
): boolean {
  const targetHostId = getRuntimeTargetHostId(target)
  if (!targetHostId) {
    return runHostId === getRepoExecutionHostId(repo)
  }
  if (getRepoExecutionHostId(repo) !== targetHostId) {
    return false
  }
  const connectionId = getRepoSshConnectionId(repo)
  return connectionId
    ? runHostId === toSshExecutionHostId(connectionId)
    : runHostId === 'local' || runHostId === targetHostId
}
