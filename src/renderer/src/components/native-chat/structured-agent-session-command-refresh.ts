import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Asks the host for a chat's `/` surface once. A resting chat's list refreshes when it is stale
 *  and arrives through the stream, so the reply is not read. */
export function refreshStructuredAgentSessionCommands(
  target: RuntimeClientTarget,
  sessionId: string
): void {
  void callStructuredAgentSession(target, 'agentSession.commands', { sessionId }).catch(
    () => undefined
  )
}
