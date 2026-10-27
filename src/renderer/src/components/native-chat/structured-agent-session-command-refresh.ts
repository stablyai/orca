import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Refresh stale commands once; the stream delivers the list, so discard the RPC reply. */
export function refreshStructuredAgentSessionCommands(
  target: RuntimeClientTarget,
  sessionId: string
): void {
  void callStructuredAgentSession(target, 'agentSession.commands', { sessionId }).catch(
    () => undefined
  )
}
