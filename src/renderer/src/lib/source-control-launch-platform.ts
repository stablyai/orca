import { resolveAgentStartupPlatform } from '@/lib/agent-startup-target'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

export function resolveSourceControlLaunchPlatform(args: {
  connectionId?: string | null
  executionHostId?: string | null
  worktreePath?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
}): NodeJS.Platform {
  return resolveAgentStartupPlatform({
    host: {
      connectionId: args.connectionId,
      executionHostId: args.executionHostId
    },
    worktreePath: args.worktreePath,
    projectRuntime: args.projectRuntime
  })
}
