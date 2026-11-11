import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { AppState } from '@/store/types'
import type { PtyTransport } from '../pty-transport-types'

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

export type PaneOwnerTransport = Partial<
  Pick<PtyTransport, 'getRuntimeEnvironmentId' | 'getExecutionHostId' | 'onExecutionHostChange'>
> | null

export type RemotePtyOwnerMachine =
  | { kind: 'ssh'; targetId: string; runtimeEnvironmentId: string | null }
  | { kind: 'runtime'; environmentId: string }

/**
 * The remote machine whose process owns the pane's PTY, or null when none can be named. A paired
 * server's transport names the PTY's own host: a pane mirrored as `runtime:<env>` can be that
 * server's SSH target, whose OS is not the server's. A transport that cannot name its host yet
 * falls back to the pane's own owner.
 */
export function resolveRemotePtyOwnerMachine(
  owner: { executionHostId: string; runtimeEnvironmentId: string | null },
  transport: PaneOwnerTransport = null
): RemotePtyOwnerMachine | null {
  const transportEnvironmentId = transport?.getRuntimeEnvironmentId?.() ?? null
  if (transportEnvironmentId) {
    const host =
      parseExecutionHostId(transport?.getExecutionHostId?.()) ??
      parseExecutionHostId(owner.executionHostId)
    return host?.kind === 'ssh'
      ? { kind: 'ssh', targetId: host.targetId, runtimeEnvironmentId: transportEnvironmentId }
      : { kind: 'runtime', environmentId: transportEnvironmentId }
  }
  const host = parseExecutionHostId(owner.executionHostId)
  if (host?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: host.environmentId }
  }
  if (host?.kind === 'ssh') {
    return {
      kind: 'ssh',
      targetId: host.targetId,
      runtimeEnvironmentId: owner.runtimeEnvironmentId
    }
  }
  return null
}

/** OS of a remote PTY owner, or null until its SSH state or server status reports it. */
export function remotePtyOwnerMachinePlatform(
  state: PtyOwnerMachineState,
  machine: RemotePtyOwnerMachine
): NodeJS.Platform | null {
  return machine.kind === 'ssh'
    ? sshTargetRemotePlatform(state, machine.targetId, machine.runtimeEnvironmentId)
    : runtimeHostPlatform(state, machine.environmentId)
}
