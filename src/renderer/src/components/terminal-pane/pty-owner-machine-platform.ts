import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { AppState } from '@/store/types'

export type PtyOwnerMachineState = Pick<
  AppState,
  'sshConnectionStates' | 'sshStateByEnvironment' | 'runtimeStatusByEnvironmentId'
>

/** OS an SSH target reports; a target reached through a paired server is in that server's SSH state. */
export function sshTargetRemotePlatform(
  state: PtyOwnerMachineState,
  targetId: string,
  runtimeEnvironmentId: string | null
): NodeJS.Platform | null {
  const connectionState = runtimeEnvironmentId
    ? state.sshStateByEnvironment.get(runtimeEnvironmentId)?.connectionStates.get(targetId)
    : state.sshConnectionStates.get(targetId)
  return connectionState?.remotePlatform ?? null
}

/** Last-verified OS of a paired server; outages keep it (ssh-execution-boundary.md). */
export function runtimeHostPlatform(
  state: PtyOwnerMachineState,
  runtimeEnvironmentId: string
): NodeJS.Platform | null {
  return (
    lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId))
      ?.hostPlatform ?? null
  )
}

/** OS of the remote machine whose process owns the pane's PTY, or null for local or unknown owners. */
export function resolveRemotePtyOwnerMachinePlatform(
  state: PtyOwnerMachineState,
  owner: { executionHostId: string; runtimeEnvironmentId: string | null }
): NodeJS.Platform | null {
  const host = parseExecutionHostId(owner.executionHostId)
  if (host?.kind === 'runtime') {
    return runtimeHostPlatform(state, host.environmentId)
  }
  if (host?.kind === 'ssh') {
    return sshTargetRemotePlatform(state, host.targetId, owner.runtimeEnvironmentId)
  }
  return null
}
