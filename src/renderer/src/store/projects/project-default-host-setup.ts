import type { Project } from '../../../../shared/project-types'
import type { AppState } from '../types'
import { selectCanonicalProjects } from '../project-host-setup-selector'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { assertRuntimeEnvironmentCapability } from '../../runtime/runtime-rpc-client'

export function configuredProjectDefault(
  state: AppState,
  projectId: string
): Project['defaultTuiAgent'] {
  return selectCanonicalProjects(state).find((project) => project.id === projectId)?.defaultTuiAgent
}

export async function assertProjectDefaultSetupSupport(
  target: RuntimeClientTarget,
  defaultTuiAgent: Project['defaultTuiAgent']
): Promise<void> {
  if (defaultTuiAgent !== undefined && target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY,
      'The target Orca host cannot save this project default agent. Update Orca on that host before adding a setup.',
      15_000
    )
  }
}

export function confirmProjectDefaultOnSetupHost<T extends { project: Project }>(
  result: T,
  defaultTuiAgent: Project['defaultTuiAgent']
): T {
  if (defaultTuiAgent !== undefined && result.project.defaultTuiAgent !== defaultTuiAgent) {
    throw new Error(
      'Project setup may have been created, but the target host did not confirm its default agent. Refresh projects before retrying.'
    )
  }
  return result
}
