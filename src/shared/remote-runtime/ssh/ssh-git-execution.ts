import { parseExecutionHostId, type ExecutionHostId } from '../../execution-host'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../host-catalog/runtime-environments'
import type { SshTarget } from './ssh-types'

export type SshGitExecution = 'local' | 'remote'

export type SshGitExecutionPolicy = {
  /** Desktop-owned routing for Orca Git and hosted-provider operations; absent uses this SSH host. */
  gitExecution?: SshGitExecution
  /** Project checkout paths override this target's Git execution default. */
  gitExecutionProjects?: Record<string, SshGitExecution>
}

export function normalizeSshGitExecution(value: unknown): SshGitExecution | undefined {
  return value === 'local' || value === 'remote' ? value : undefined
}

export function normalizeSshGitExecutionProjects(
  value: unknown
): Record<string, SshGitExecution> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const projects: Record<string, SshGitExecution> = {}
  for (const [projectPath, requested] of Object.entries(value)) {
    const execution = normalizeSshGitExecution(requested)
    if (
      projectPath.includes('\0') ||
      !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(projectPath) ||
      !execution
    ) {
      return undefined
    }
    projects[projectPath] = execution
  }
  return projects
}

export function getSshGitExecution(
  target: Pick<SshTarget, 'gitExecution' | 'gitExecutionProjects'>,
  repoPath: string
): SshGitExecution {
  return target.gitExecutionProjects?.[repoPath] ?? target.gitExecution ?? 'remote'
}

export function findSshGitExecutionTarget(
  targets: readonly SshTarget[],
  hostId: ExecutionHostId,
  environments: readonly Pick<KnownRuntimeEnvironment, 'id' | 'orcadDeployment' | 'sshAccess'>[]
): SshTarget | undefined {
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'ssh') {
    return targets.find((target) => target.id === host.targetId)
  }
  if (host?.kind !== 'runtime') {
    return undefined
  }
  const environment = environments.find((entry) => entry.id === host.environmentId)
  const access = environment ? getRuntimeSshAccess(environment) : undefined
  return targets.find((target) =>
    access
      ? target.id === access.sshTargetId && target.generation === access.sshTargetGeneration
      : target.orcadFence?.environmentId === host.environmentId
  )
}
