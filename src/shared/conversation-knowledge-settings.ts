import type { TuiAgent } from './agent-launch/catalog/tui-agent'

export type ConversationKnowledgeSettings = {
  conversationKnowledgeEnabled?: boolean
  conversationKnowledgeEnrichmentEnabled?: boolean
  conversationKnowledgeEnrichmentAgent?: TuiAgent | null
  conversationKnowledgeEnrichmentModel?: string | null
  conversationKnowledgeEnrichmentScope?: 'new-sessions' | 'current-project' | 'all-history'
}

export const DEFAULT_CONVERSATION_KNOWLEDGE_SETTINGS = {
  conversationKnowledgeEnabled: false,
  conversationKnowledgeEnrichmentEnabled: false,
  conversationKnowledgeEnrichmentAgent: null,
  conversationKnowledgeEnrichmentModel: null,
  conversationKnowledgeEnrichmentScope: 'all-history'
} satisfies ConversationKnowledgeSettings
