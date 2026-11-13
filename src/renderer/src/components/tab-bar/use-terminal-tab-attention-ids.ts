import { useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { terminalTabHasUnreadActivity } from './terminal-tab-activity-status'
import { createActivityStatusSelector } from './use-terminal-tab-activity'

const NONE = ''

/**
 * Terminal tabs that need the user: an unread agent completion/bell (the tab's amber bell) or an
 * agent waiting on input. Returned as one joined string so unrelated store writes don't re-render.
 */
export function useTerminalTabAttentionIds(tabs: readonly TerminalTab[]): ReadonlySet<string> {
  const [selectors] = useState(
    () => new Map<string, ReturnType<typeof createActivityStatusSelector>>()
  )
  const joined = useAppStore((s) => {
    if (tabs.length === 0) {
      return NONE
    }
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
      if (
        status === 'permission' ||
        terminalTabHasUnreadActivity({
          terminalTabId: tab.id,
          unreadTerminalTabs: s.unreadTerminalTabs,
          unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
        })
      ) {
        ids.push(tab.id)
      }
    }
    return ids.join('\u0000')
  })
  return useMemo(() => new Set(joined === NONE ? [] : joined.split('\u0000')), [joined])
}
