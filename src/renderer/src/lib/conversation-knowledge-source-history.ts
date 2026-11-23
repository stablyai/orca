import { selectConversationHistoryTarget } from './conversation-history-selection'
import { useAppStore } from '@/store'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'

export function openConversationKnowledgeSourceHistory(
  item: ConversationKnowledgeItem,
  scope: 'all' | 'project'
): void {
  selectConversationHistoryTarget({ ...item.source, scope })
  const store = useAppStore.getState()
  store.setConversationKnowledgeDrawerOpen(false)
  store.setRightSidebarTab('vault')
  store.setRightSidebarOpen(true)
  window.dispatchEvent(new Event('orca:conversation-history-select'))
}
