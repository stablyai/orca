import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type { TabBarItem } from './tab-bar-item-model'

export function findActiveVisibleTabId(
  items: readonly TabBarItem[],
  active: {
    activeTabId: string | null
    activeFileId?: string | null
    activeBrowserTabId?: string | null
    activeSimulatorTabId?: string | null
    activeTabType?: WorkspaceVisibleTabType | 'agents'
  }
): string | null {
  const activeItem = items.find((item) => {
    if (item.type === 'terminal') {
      return (
        (active.activeTabType === 'terminal' || active.activeTabType === 'simulator') &&
        item.id === active.activeTabId
      )
    }
    if (item.type === 'browser') {
      return active.activeTabType === 'browser' && item.id === active.activeBrowserTabId
    }
    if (item.type === 'simulator') {
      return active.activeTabType === 'simulator' && item.id === active.activeSimulatorTabId
    }
    if (item.type === 'agents') {
      return active.activeTabType === 'agents' && item.id === active.activeTabId
    }
    if (item.type === 'agent-session') {
      // Structured-chat callers pass their unified tab ID; the background terminal’s activeTabId cannot identify this item.
      return active.activeTabType === 'agent-session' && item.id === active.activeTabId
    }
    return (
      (active.activeTabType === 'editor' || active.activeTabType === 'simulator') &&
      active.activeFileId === item.id
    )
  })
  return activeItem?.id ?? null
}
