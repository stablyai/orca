import type { Tab } from '../../../../shared/tab-types'

/** Presentation actions use terminal entityId for backed tabs, unified ID for rowless structured chats. */
export function findRenamableUnifiedTab(
  unifiedTabsByWorktree: Record<string, Tab[]>,
  tabId: string
): Tab | undefined {
  const unified = Object.values(unifiedTabsByWorktree).flat()
  return (
    unified.find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId) ??
    unified.find((entry) => entry.contentType === 'agent-session' && entry.id === tabId)
  )
}
