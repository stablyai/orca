import { useMemo, useState } from 'react'
import { useAppStore } from '../../../store'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  isTerminalTabActivityLive,
  terminalTabHasUnreadActivity
} from './terminal-tab-activity-status'
import { createActivityStatusSelector } from './use-terminal-tab-activity'

const NONE = ''

/**
 * Tabs that need the user, by the same signals their tab shows: an agent waiting on input, or an
 * unread completion/bell (suppressed while a newer live turn owns the tab, like the tab's bell).
 * Structured-chat tabs carry only the unread marker. One joined string, so unrelated writes don't re-render.
 */
export function useTerminalTabAttentionIds(
  tabs: readonly TerminalTab[],
  chatTabIds: readonly string[]
): ReadonlySet<string> {
  const [selectors] = useState(
    () => new Map<string, ReturnType<typeof createActivityStatusSelector>>()
  )
  const joined = useAppStore((s) => {
    if (tabs.length === 0 && chatTabIds.length === 0) {
      return NONE
    }
    const hasUnread = (tabId: string): boolean =>
      terminalTabHasUnreadActivity({
        terminalTabId: tabId,
        unreadTerminalTabs: s.unreadTerminalTabs,
        unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
      })
    const ids: string[] = []
    for (const tab of tabs) {
      let selectStatus = selectors.get(tab.id)
      if (!selectStatus) {
        selectStatus = createActivityStatusSelector()
        selectors.set(tab.id, selectStatus)
      }
      const status = selectStatus({
        tab,
        agentStatusByPaneKey: s.agentStatusByPaneKey,
        agentStatusEpoch: s.agentStatusEpoch,
        runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
        ptyIdsByTabId: s.ptyIdsByTabId,
        terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
      })
      if (status === 'permission' || (!isTerminalTabActivityLive(status) && hasUnread(tab.id))) {
        ids.push(tab.id)
      }
    }
    for (const tabId of chatTabIds) {
      if (hasUnread(tabId)) {
        ids.push(tabId)
      }
    }
    return ids.join('\u0000')
  })
  return useMemo(() => new Set(joined === NONE ? [] : joined.split('\u0000')), [joined])
}
