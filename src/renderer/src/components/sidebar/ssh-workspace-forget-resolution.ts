import type { Repo } from '../../../../shared/types'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

/**
 * How a workspace on an SSH host should be deleted, given the host's live
 * state. Drives whether the delete flow can go straight through the normal
 * remote removal, must offer a reconnect-first choice, or can only forget the
 * workspace from Orca because the SSH target is gone entirely.
 */
export type SshWorkspaceForgetResolution =
  | { kind: 'not-ssh' }
  // Target exists and the relay is connected — normal remote removal works.
  | { kind: 'connected'; targetId: string; sshOwnerEnvironmentId?: string | null }
  // Target still configured but not connected — offer Reconnect & Delete plus
  // a local-only forget fallback.
  | {
      kind: 'disconnected'
      targetId: string
      status: SshConnectionState['status']
      sshOwnerEnvironmentId?: string | null
    }
  // Target was removed; only a project-only "ghost" host remains. Reconnect is
  // impossible, so forget-from-Orca is the only path.
  | { kind: 'ghost'; targetId: string; sshOwnerEnvironmentId?: string | null }

export function resolveSshWorkspaceForget(args: {
  repo: Pick<Repo, 'connectionId'> | null | undefined
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  // Keys are configured SSH target ids (targets that still exist in settings).
  sshTargetLabels: ReadonlyMap<string, string>
  sshOwnerEnvironmentId?: string | null
  targetConfigured?: boolean
  connectionStatus?: SshConnectionStatus | null
}): SshWorkspaceForgetResolution {
  const connectionId = args.repo?.connectionId?.trim()
  // Why: runtime-owned (ephemeral-VM) SSH targets manage their own lifecycle and
  // are never user-facing ghosts, so they take the normal delete path.
  if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
    return { kind: 'not-ssh' }
  }

  const isConfigured = args.targetConfigured ?? args.sshTargetLabels.has(connectionId)
  const status = args.connectionStatus ?? args.sshConnectionStates.get(connectionId)?.status
  const ownership = args.sshOwnerEnvironmentId
    ? { sshOwnerEnvironmentId: args.sshOwnerEnvironmentId }
    : {}

  // Why: a target the user removed leaves repos pinned to a dead id with no
  // configured target — the grey ghost host. Reconnect can never succeed, so
  // the only escape is to forget it from Orca.
  if (!isConfigured) {
    return { kind: 'ghost', targetId: connectionId, ...ownership }
  }

  if (status === 'connected') {
    return { kind: 'connected', targetId: connectionId, ...ownership }
  }

  return {
    kind: 'disconnected',
    targetId: connectionId,
    status: status ?? 'disconnected',
    ...ownership
  }
}
