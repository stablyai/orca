import { resolveAgentStartupPlatform } from '@/lib/agent-startup-target'
import type { AppState } from '@/store'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export function getAgentLaunchPlatformForRepo(
  repo: Pick<AppState['repos'][number], 'connectionId' | 'executionHostId' | 'path'>,
  projectRuntime?: ProjectExecutionRuntimeResolution
): NodeJS.Platform {
  return resolveAgentStartupPlatform({ host: repo, projectRuntime })
}
