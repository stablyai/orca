import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { readCachedRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import {
  getOrcadSshDeployment,
  type OrcadDeploymentLink
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

type ServerPortForwardState = Omit<WorktreeRuntimeOwnerState, 'runtimeEnvironments'> & {
  runtimeEnvironments?: readonly { id: string; orcadDeployment?: OrcadDeploymentLink }[]
}

// The store registers itself so link routing need not import it.
let readOwnerState: (() => ServerPortForwardState) | null = null

export function registerServerPortForwardStateAccessor(fn: () => ServerPortForwardState): void {
  readOwnerState = fn
}

/** A server Orca deployed over SSH forwards through that SSH connection, as its Ports panel does. */
export function serverSshForwardTargetId(environmentId: string): string | null {
  const environment = readOwnerState?.()?.runtimeEnvironments?.find(
    (candidate) => candidate.id === environmentId
  )
  return (environment && getOrcadSshDeployment(environment)?.sshTargetId) || null
}

/** Whether this desktop can forward the paired server's localhost ports over its own connection, from its last probed status. */
export function serverForwardsPorts(environmentId: string): boolean {
  return (
    typeof window !== 'undefined' &&
    serverSshForwardTargetId(environmentId) === null &&
    window.api?.runtimeEnvironments?.portForwards !== undefined &&
    readCachedRuntimeEnvironmentCapability(
      environmentId,
      NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY
    ) === true
  )
}

/** The workspace runs on the paired server itself; one on an SSH host or WSL distro the server reaches has another localhost. */
export function workspaceRunsOnServer(
  environmentId: string,
  worktreeId: string | null | undefined
): boolean {
  const state = readOwnerState?.()
  return Boolean(
    state &&
    worktreeId &&
    getExecutionHostIdForWorktree(state, worktreeId) === toRuntimeExecutionHostId(environmentId)
  )
}

/** A system-browser open of this workspace's server localhost can go through a forward of that port. */
export function serverForwardsWorkspacePorts(
  environmentId: string,
  worktreeId: string | null | undefined
): boolean {
  return serverForwardsPorts(environmentId) && workspaceRunsOnServer(environmentId, worktreeId)
}
