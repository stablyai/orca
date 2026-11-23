import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'
import { useAppStore } from '@/store'

let pendingKnowledgeItem: ConversationKnowledgeItem | null = null

export function selectConversationKnowledgeItem(item: ConversationKnowledgeItem): void {
  pendingKnowledgeItem = item
}

export function openConversationKnowledgeItem(item: ConversationKnowledgeItem): void {
  selectConversationKnowledgeItem(item)
  useAppStore.getState().setConversationKnowledgeDrawerOpen(true)
  window.dispatchEvent(new Event('orca:conversation-knowledge-select'))
}

export function consumeConversationKnowledgeItem(): ConversationKnowledgeItem | null {
  const item = pendingKnowledgeItem
  pendingKnowledgeItem = null
  return item
}
