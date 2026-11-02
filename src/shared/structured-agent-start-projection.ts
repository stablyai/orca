import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import { agentJournalItemRowOrigin } from './agent-session/journal/agent-session-journal-position'
import { agentJournalLinkageFields } from './agent-session/journal/agent-session-journal-producer'
import { readAgentMessageSource } from './agent-session/agent-session-message-source'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { projectStructuredItemToNativeChat } from './agent-session/view/structured-agent-session-projection'

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
    ...(body.kind === 'agent-handoff' ? { agentHandoff: true as const } : {}),
    from: readAgentMessageSource({
      kind: 'agent',
      senders: [body.kind === 'agent-handoff' ? body.agent : body.worker],
      orchestration: null
    })
  }
}
