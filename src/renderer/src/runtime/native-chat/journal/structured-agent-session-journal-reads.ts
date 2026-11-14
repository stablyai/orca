import '../../../../../shared/agent-session/agent-session-attention-capabilities'
import { AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../../../shared/agent-session/lifecycle/stopping/agent-session-stop-capabilities'
import '../../../../../shared/agent-session/agent-session-create-capabilities'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import '../../rpc/compatibility/runtime-capability-proof'
import '../../hosts/capabilities/local-runtime-capabilities'
import '../../rpc/subscriptions/runtime-rpc-subscribe'
import '../requests/structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { AgentSessionConversationOutline } from '../../../../../shared/agent-session/agent-session-conversation-outline'
import { structuredAgentSessionHostSupports } from '../host-capabilities/structured-agent-session-host-support'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

/** Null when the host predates the outline, without calling it. A failed read
 *  rejects, so the caller can retry it; the rail maps loaded messages meanwhile. */
export async function readStructuredAgentSessionConversationOutline(
  target: RuntimeClientTarget,
  sessionId: string
): Promise<AgentSessionConversationOutline | null> {
  if (
    !(await structuredAgentSessionHostSupports(
      target,
      AGENT_SESSION_CONVERSATION_OUTLINE_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return callRuntimeRpc<AgentSessionConversationOutline>(
    target,
    'agentSession.conversationOutline',
    { sessionId }
  )
}

/** One item whole, as the host keeps it; null when the host no longer has it. Call only after
 *  `supportsStructuredAgentSessionItemDetail`; a failed read rejects. */
export async function readStructuredAgentSessionItem(
  target: RuntimeClientTarget,
  sessionId: string,
  itemId: string
): Promise<AgentJournalRenderItem | null> {
  const result = await callRuntimeRpc<{ item: AgentJournalRenderItem | null }>(
    target,
    'agentSession.item',
    { sessionId, itemId }
  )
  return result?.item ?? null
}
