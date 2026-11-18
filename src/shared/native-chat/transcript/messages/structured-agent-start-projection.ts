import type {
  AgentJournalAgentStartItem,
  AgentJournalRenderItem
} from '../../../agent-session/journal/agent-session-journal-types'
import { agentJournalItemRowOrigin } from '../../../agent-session/journal/agent-session-journal-position'
import { agentJournalLinkageFields } from '../../../agent-session/journal/agent-session-journal-producer'
import {
  readAgentMessageSource,
  type AgentMessageSender
} from '../../../agent-session/journal/agent-session-message-source'
import type { NativeChatMessage } from '../../native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../agent-session/view/structured-agent-session-projection'

/** Display-only creation facts are opt-in; canonical transcript readers keep their existing meaning. */
export function projectStructuredAgentStartItem(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  const { body } = item
  if (body.kind !== 'agent-start' && body.kind !== 'agent-handoff') {
    return projectStructuredItemToNativeChat(item)
  }
  if (item.shortened) {
    return null
  }
  return {
    ...agentJournalItemRowOrigin(item),
    ...agentJournalLinkageFields(item),
    role: 'system',
    blocks: [{ type: 'text', text: body.task }],
    agentStart: true,
    ...(body.kind === 'agent-start' ? { agentStartDispatchId: body.dispatchId } : {}),
    ...(body.kind === 'agent-start' && body.followUp
      ? { agentFollowUp: body.followUp.reopened ? ('reopened' as const) : ('fresh' as const) }
      : {}),
    ...(body.kind === 'agent-handoff' ? { agentHandoff: true as const } : {}),
    from: readAgentMessageSource({
      kind: 'agent',
      senders: [body.kind === 'agent-handoff' ? body.agent : legacyStartSender(body)],
      orchestration: null
    })
  }
}

// Earlier bot builds kept the started agent beside the worker, not on it.
function legacyStartSender(body: AgentJournalAgentStartItem): AgentMessageSender {
  return body.agent && !body.worker.agent ? { ...body.worker, agent: body.agent } : body.worker
}
