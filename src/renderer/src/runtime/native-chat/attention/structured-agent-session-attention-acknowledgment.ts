import { AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-attention-capabilities'
import '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-capabilities'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import '../../rpc/compatibility/runtime-capability-proof'
import '../../hosts/capabilities/local-runtime-capabilities'
import '../../rpc/subscriptions/runtime-rpc-subscribe'
import '../requests/structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AgentJournalCursor } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import { structuredAgentSessionHostSupports } from '../host-capabilities/structured-agent-session-host-support'

/** The user read this chat: the owning host withdraws the phone alerts it pushed for it. An older
 *  host has no such method and is skipped; a failure is bookkeeping and only logged. */
export async function acknowledgeStructuredAgentSessionAttention(
  target: RuntimeClientTarget,
  sessionId: string,
  observedCursor: AgentJournalCursor
): Promise<boolean> {
  const capturedCursor = { ...observedCursor }
  try {
    if (
      !(await structuredAgentSessionHostSupports(
        target,
        AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
      ))
    ) {
      return false
    }
    const result = await callRuntimeRpc<{ acknowledged: boolean }>(
      target,
      'agentSession.acknowledgeAttention',
      { sessionId, observedCursor: capturedCursor }
    )
    return result.acknowledged
  } catch (error) {
    console.warn('[structured-session-attention] acknowledgement failed', error)
    return false
  }
}
