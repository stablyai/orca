import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { agentJournalItemRowOrigin } from './agent-session-journal-position'
import { agentJournalLinkageFields } from './agent-session-journal-producer'
import { readAgentMessageSource } from './agent-session/agent-session-message-source'
import type { NativeChatMessage } from './native-chat-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

/** Display-only creation facts are opt-in; canonical transcript readers keep their existing meaning. */
export function projectStructuredAgentStartItem(
  item: AgentJournalRenderItem
): NativeChatMessage | null {
  if (item.body.kind !== 'agent-start') {
    return projectStructuredItemToNativeChat(item)
  }
  if (item.shortened) {
    return null
  }
  return {
    ...agentJournalItemRowOrigin(item),
    ...agentJournalLinkageFields(item),
    role: 'system',
    blocks: [{ type: 'text', text: item.body.task }],
    agentStart: true,
    from: readAgentMessageSource({
      kind: 'agent',
      senders: [item.body.worker],
      orchestration: null
    })
  }
}
