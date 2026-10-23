import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  getManagedOrcadSshTargetId,
  type ManagedOrcadEnvironmentSummary
} from '../../../shared/managed-orcad-execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** The host whose Orca skills the Update dialog, badge and nudge plan and update. */
export type BundledSkillTarget =
  | { kind: 'local' }
  /** A paired server or the managed server on an SSH host; it plans its own disk. */
  | { kind: 'environment'; environmentId: string }
  /** An SSH host no Orca server serves yet: nothing can plan it until it connects. */
  | { kind: 'ssh'; targetId: string }

/** Keys runs and nudge dismissals, so one host's result never reads as another's. */
export function bundledSkillTargetKey(target: BundledSkillTarget): string {
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'environment':
      return `runtime:${target.environmentId}`
    case 'ssh':
      return `ssh:${target.targetId}`
  }
}

/** An SSH host's owner id, rewritten to the managed server that serves that host, if any. */
export function servingExecutionHostId(
  hostId: ExecutionHostId | null,
  runtimeEnvironments: readonly ManagedOrcadEnvironmentSummary[] | undefined
): string | null {
  const owner = parseExecutionHostId(hostId)
  if (owner?.kind !== 'ssh') {
    return hostId
  }
  const server = runtimeEnvironments?.find(
    (environment) => getManagedOrcadSshTargetId(environment) === owner.targetId
  )
  return server ? toRuntimeExecutionHostId(server.id.trim()) : hostId
}

/**
 * Where the agents run, never the client by default: null while the owning runtime is
 * unknown or the project runs in WSL. Pass the active workspace's owner
 * through `servingExecutionHostId`, so an SSH host with a managed server plans on that server.
 * An omitted owner means no active workspace; null means its owner is unresolved.
 */
export function resolveBundledSkillTarget(
  runtimeTarget: RuntimeClientTarget | null,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  activeWorkspaceHostId?: string | null
): BundledSkillTarget | null {
  const owner = parseExecutionHostId(activeWorkspaceHostId)
  if (activeWorkspaceHostId !== undefined && !owner) {
    return null
  }
  if (owner?.kind === 'ssh') {
    return { kind: 'ssh', targetId: owner.targetId }
  }
  if (owner?.kind === 'runtime') {
    return { kind: 'environment', environmentId: owner.environmentId }
  }
  if (!runtimeTarget) {
    return null
  }
  if (runtimeTarget.kind === 'environment') {
    return { kind: 'environment', environmentId: runtimeTarget.environmentId }
  }
  if (projectRuntime?.status === 'repair-required') {
    return null
  }
  return projectRuntime?.runtime.kind === 'wsl' ? null : { kind: 'local' }
}
