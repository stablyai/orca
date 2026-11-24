import { useAppStore } from '../../../store'
import { selectClientHostedBrowserRow } from '@/runtime/browser/client-hosting/client-hosted-browser-row-state'
import type { TabBarItemActions } from '../model/use-tab-bar-item-actions'
import type { TabStripEntry } from './TabStripOverflowChip'

/** Activates a +N list entry through the same paths a click on its tab uses. */
export function activateTabStripEntry({
  entry,
  worktreeId,
  groupId,
  groupActiveTabId,
  itemActions
}: {
  entry: TabStripEntry
  worktreeId: string
  groupId: string
  groupActiveTabId: string | null
  itemActions: TabBarItemActions
}): void {
  if (entry.kind === 'paired') {
    useAppStore.getState().focusGroup(worktreeId, groupId)
    selectClientHostedBrowserRow({
      worktreeId,
      browserPageId: entry.row.browserPageId,
      groupId,
      groupActiveTabIdAtSelection: groupActiveTabId
    })
    return
  }
  const { item } = entry
  if (item.type === 'terminal') {
    itemActions.activateTerminal(item.id)
  } else if (item.type === 'browser') {
    itemActions.activateBrowserTab(item.id)
  } else if (item.type === 'agent-session' || item.type === 'room') {
    itemActions.activateAgentSession(item.id)
  } else {
    itemActions.activateFile(item.id)
  }
}
