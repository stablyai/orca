import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { TerminalTab } from '../../../../shared/types'
import {
  resolveTerminalTabActivityPresentation,
  resolveTerminalTabUnreadActivity,
  type TerminalTabActivityPresentation,
  type TerminalTabUnreadKind
} from './terminal-tab-activity-status'

export type TerminalTabStatusPresentation = TerminalTabActivityPresentation & {
  hasUnreadActivity: boolean
  unreadActivityKind: TerminalTabUnreadKind | null
  unreadActivityAgent: TerminalTabActivityPresentation['agent']
}

/** Select the pane-aggregate state and its truthful provider ownership. */
export function useTerminalTabStatusPresentation(
  tab: Pick<TerminalTab, 'id' | 'title'> & Partial<Pick<TerminalTab, 'launchAgent'>>
): TerminalTabStatusPresentation {
  return useAppStore(
    useShallow((state) => {
      const unread = resolveTerminalTabUnreadActivity({
        tabId: tab.id,
        hasUnreadTerminalTab: state.unreadTerminalTabs[tab.id] === true,
        unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
        sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey
      })
      const activity = resolveTerminalTabActivityPresentation({
        tab,
        agentStatusByPaneKey: state.agentStatusByPaneKey,
        agentStatusEpoch: state.agentStatusEpoch,
        runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
        ptyIdsByTabId: state.ptyIdsByTabId,
        terminalLayout: state.terminalLayoutsByTabId?.[tab.id]
      })

      // Why: one shallow tuple computes each aggregate once per write while
      // still suppressing renders when another tab's primitives change.
      return {
        hasUnreadActivity: unread.hasUnread,
        unreadActivityKind: unread.kind,
        unreadActivityAgent: unread.agent,
        status: activity.status,
        agent: activity.agent
      }
    })
  )
}
