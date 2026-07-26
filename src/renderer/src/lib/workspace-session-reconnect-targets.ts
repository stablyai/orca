import type { WorkspaceSessionState } from '../../../shared/types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isRuntimeOwnedSshTargetId } from '../../../shared/execution-host'
import type { WorkspaceSessionSnapshot } from './workspace-session'

export function buildActiveConnectionIdsAtShutdown(
  snapshot: WorkspaceSessionSnapshot,
  // Why: required (null = none) rather than defaulted — every caller already
  // has the terminal session data in hand, and a default initializer would
  // re-run the full repo/worktree scan on the shutdown-critical path.
  remoteSessionIdsByTabId: WorkspaceSessionState['remoteSessionIdsByTabId'] | null
): WorkspaceSessionState['activeConnectionIdsAtShutdown'] {
  // Why: sshConnectionStates is a Map<string, SshConnectionState>, not a plain
  // object. Object.entries() on a Map returns [] — must use Array.from().
  // Runtime-owned states are normally never broadcast to the renderer, but a
  // pane-level optimistic write could stamp one; exclude them here too.
  const targetIds = new Set(
    Array.from(snapshot.sshConnectionStates.entries())
      .filter(
        ([targetId, state]) => state.status === 'connected' && !isRuntimeOwnedSshTargetId(targetId)
      )
      .map(([targetId]) => targetId)
  )

  // Why: shutdown can observe SSH in a transient state (relay drop mid-quit,
  // exhausted reconnect) after the socket closed but before the snapshot
  // flushed. The durable PTY id still names the target Orca must reconnect to
  // restore that surviving remote session. Two exclusions:
  // 'disconnected'/'auth-failed'/never-observed usually mean an explicit user
  // disconnect or a failed/cancelled connect — startup must not auto-dial a
  // host the user left offline or stack credential dialogs (sessions still
  // restore on tab focus via the deferred flow, so only eagerness is lost).
  // Runtime-owned (ephemeral-VM) targets belong to the runtime layer; a
  // renderer-driven ssh.connect would dispose the runtime's live relay session.
  for (const sessionId of Object.values(remoteSessionIdsByTabId ?? {})) {
    const connectionId = parseAppSshPtyId(sessionId)?.connectionId
    if (!connectionId || isRuntimeOwnedSshTargetId(connectionId)) {
      continue
    }
    const status = snapshot.sshConnectionStates.get(connectionId)?.status
    if (status && status !== 'disconnected' && status !== 'auth-failed') {
      targetIds.add(connectionId)
    }
  }

  return targetIds.size > 0 ? Array.from(targetIds) : undefined
}
