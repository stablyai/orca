import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { retireStructuredAgentSessionTab } from '@/runtime/structured-agent-session-tab-retirement'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'

// Chats a cancel closed on this machine's host; session ids are never reused.
const closedByLocalCancel = new Set<string>()

/** A create reply for a chat closed meanwhile must not bring back its conversation reader. */
export function wasStructuredAgentLaunchClosedByLocalCancel(sessionId: string): boolean {
  return closedByLocalCancel.has(sessionId)
}

export function resetStructuredAgentLocalLaunchCancelsForTests(): void {
  closedByLocalCancel.clear()
}

/**
 * ORCA_LAYOUT_OWNER=main only: this machine's host refuses a create whose close came first, or
 * closes the chat as it lands, so a local cancel retires the chat on the host at once and keeps no
 * tombstone. A failed retire is logged; main still remembers the close.
 */
export function cancelStructuredAgentLaunchOnLocalHost(
  worktreeId: string,
  sessionId: string
): void {
  deleteStructuredAgentLaunchRecord(sessionId)
  // Why: main answers a create for a chat closed meanwhile as ok, and no tombstone is written.
  closedByLocalCancel.add(sessionId)
  void retireStructuredAgentSessionTab({
    target: { kind: 'local' },
    worktreeId,
    sessionId,
    onError: (error) => {
      // A create that has not landed has no host tab yet; main still heard the close.
      if (!hasRuntimeRpcErrorCode(error, 'tab_not_found')) {
        console.warn('[structured-agent-session] local cancel retirement failed', error)
      }
    }
  })
}
