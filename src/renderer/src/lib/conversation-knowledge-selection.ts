import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'

let pendingKnowledgeItem: ConversationKnowledgeItem | null = null

export function selectConversationKnowledgeItem(item: ConversationKnowledgeItem): void {
  pendingKnowledgeItem = item
}

export function consumeConversationKnowledgeItem(): ConversationKnowledgeItem | null {
  const item = pendingKnowledgeItem
  pendingKnowledgeItem = null
  return item
}
