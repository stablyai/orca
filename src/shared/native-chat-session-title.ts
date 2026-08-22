import type { AgentType } from './agent-status-types'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from './agent-row-conversation-name'
import { formatAgentTypeLabel } from './agent-type-label'

export function resolveNativeChatConversationTitle(
  tab: ConversationNameTab,
  agent: AgentType,
  generatedTitlesEnabled: boolean
): string | null {
  return getAgentRowConversationName(tab, agent, generatedTitlesEnabled)
}

export function resolveNativeChatSessionTitle(
  tab: ConversationNameTab,
  agent: AgentType,
  generatedTitlesEnabled: boolean
): string {
  return (
    resolveNativeChatConversationTitle(tab, agent, generatedTitlesEnabled) ??
    `${formatAgentTypeLabel(agent)} chat`
  )
}
