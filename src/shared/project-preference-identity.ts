import { toSshExecutionHostId, type ExecutionHostId } from './execution-host'
import type { ProjectSectionSetup } from './project-section-grouping'

export function projectPreferenceKeyForSetup(setup: ProjectSectionSetup): string {
  if (setup.projectId.startsWith('github:') || setup.projectId.startsWith('git:')) {
    return setup.projectId
  }
  const executionHost = setup.connectionId
    ? toSshExecutionHostId(setup.connectionId)
    : (setup.executionHostId ?? setup.hostId)
  return JSON.stringify([setup.hostId, executionHost, setup.projectId])
}

export function resolveProjectPreferenceKey(
  repoId: string,
  setups: readonly ProjectSectionSetup[],
  ownerHostId?: ExecutionHostId | null
): string | null {
  const keys = new Set(
    setups
      .filter((setup) => setup.repoId === repoId && (!ownerHostId || setup.hostId === ownerHostId))
      .map(projectPreferenceKeyForSetup)
  )
  return keys.size === 1 ? (keys.values().next().value ?? null) : null
}
