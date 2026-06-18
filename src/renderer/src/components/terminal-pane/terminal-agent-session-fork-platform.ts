import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../../shared/wsl-paths'

export function getForkAgentLaunchPlatform(args: {
  repo: { connectionId?: string | null } | null | undefined
  worktreePath?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
}): NodeJS.Platform | undefined {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : undefined
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.repo?.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return undefined
}
