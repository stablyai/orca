import type { Repo } from '../../../../shared/repo-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

/** Choose normal deletion, reconnect-or-forget, or forget-only from SSH target state. */
export type SshWorkspaceForgetResolution =
  | { kind: 'not-ssh' }
  // Connected targets allow normal remote removal.
  | { kind: 'connected'; targetId: string }
  // Configured offline targets offer reconnect or local forget.
  | { kind: 'disconnected'; targetId: string; status: SshConnectionState['status'] }
  // Removed targets cannot reconnect; only local forget remains.
  | { kind: 'ghost'; targetId: string }

export function resolveSshWorkspaceForget(args: {
  repo: Pick<Repo, 'connectionId'> | null | undefined
  sshConnectionStates: ReadonlyMap<string, SshConnectionState>
  // Keys are configured SSH target ids (targets that still exist in settings).
  sshTargetLabels: ReadonlyMap<string, string>
}): SshWorkspaceForgetResolution {
  const connectionId = args.repo?.connectionId?.trim()
  // Runtime-owned ephemeral targets manage their lifecycle and must never become user-facing ghosts.
  if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
    return { kind: 'not-ssh' }
  }

  const isConfigured = args.sshTargetLabels.has(connectionId)
  const status = args.sshConnectionStates.get(connectionId)?.status

  // An unconfigured target cannot reconnect; offer local forget for its remaining records.
  if (!isConfigured) {
    return { kind: 'ghost', targetId: connectionId }
  }

  if (status === 'connected') {
    return { kind: 'connected', targetId: connectionId }
  }

  return { kind: 'disconnected', targetId: connectionId, status: status ?? 'disconnected' }
}
