export type ConversationKnowledgeViewMode = 'all' | 'project'

const STORAGE_KEY = 'orca:conversation-knowledge:view-mode'

export function readConversationKnowledgeViewMode(
  storage: Pick<Storage, 'getItem'>
): ConversationKnowledgeViewMode {
  try {
    return storage.getItem(STORAGE_KEY) === 'project' ? 'project' : 'all'
  } catch {
    return 'all'
  }
}

export function writeConversationKnowledgeViewMode(
  storage: Pick<Storage, 'setItem'>,
  mode: ConversationKnowledgeViewMode
): void {
  try {
    storage.setItem(STORAGE_KEY, mode)
  } catch {
    // Storage can be unavailable in restricted renderer environments.
  }
}
