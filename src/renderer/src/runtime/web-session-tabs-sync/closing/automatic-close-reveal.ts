// Asks this machine's host to show a chat's tab again after this window kept it from Orca's own close.
// Runs after the snapshot step that decided it, never inside it.
import { callStructuredAgentSession } from '../../native-chat/requests/structured-agent-session-call'

export function revealAutomaticallyClosedChat(sessionId: string): void {
  queueMicrotask(() => {
    void callStructuredAgentSession({ kind: 'local' }, 'agentSession.reveal', { sessionId }).catch(
      (error: unknown) =>
        console.warn('[structured-agent-session] could not show a kept chat', error)
    )
  })
}
