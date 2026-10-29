import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isOwnedSshTargetId } from '../../../shared/execution-host'
import type { WorkspaceSessionSnapshot } from './workspace-session'

export function buildActiveConnectionIdsAtShutdown(
  snapshot: WorkspaceSessionSnapshot,
  // Require precomputed session data (null means none) to avoid default full-catalog rescans during shutdown.
  remoteSessionIdsByTabId: WorkspaceSessionState['remoteSessionIdsByTabId'] | null
): WorkspaceSessionState['activeConnectionIdsAtShutdown'] {
  // Use Map iteration, not Object.entries; also exclude optimistic runtime-owned states even though normal broadcasts omit them.
  const targetIds = new Set(
    Array.from(snapshot.sshConnectionStates.entries())
      .filter(([targetId, state]) => state.status === 'connected' && !isOwnedSshTargetId(targetId))
      .map(([targetId]) => targetId)
  )

  // Durable PTY IDs retain reconnect targets through transient shutdown transport loss. Exclude explicit disconnect/auth-failed/unobserved targets to honor offline intent and avoid credential loops; focus restore still works. Runtime-owned targets are excluded because renderer connect can dispose their live relay.
  for (const sessionId of Object.values(remoteSessionIdsByTabId ?? {})) {
    const connectionId = parseAppSshPtyId(sessionId)?.connectionId
    if (!connectionId || isOwnedSshTargetId(connectionId)) {
      continue
    }
    const status = snapshot.sshConnectionStates.get(connectionId)?.status
    if (status && status !== 'disconnected' && status !== 'auth-failed') {
      targetIds.add(connectionId)
    }
  }

  return targetIds.size > 0 ? Array.from(targetIds) : undefined
}
