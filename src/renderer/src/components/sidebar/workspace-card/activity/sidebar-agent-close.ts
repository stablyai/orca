import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { closeSidebarAgentPane } from './sidebar-agent-pane-close'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

export function closeSidebarAgent(agent: DashboardAgentRow): void {
  if (agent.rowSource === 'subagent') {
    return
  }
  const state = useAppStore.getState()
  const { worktreeId, id: tabId } = agent.tab
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
  const terminalId = tab?.contentType === 'terminal' ? tab.entityId : tabId
  const layout = state.terminalLayoutsByTabId[terminalId]
  if (layout?.root?.type === 'split') {
    const pane = parsePaneKey(agent.paneKey)
    if (pane) {
      void closeSidebarAgentPane(worktreeId, terminalId, pane.leafId).then((handled) => {
        if (!handled) {
          toast.error(
            translate(
              'sidebar.agentActions.paneUnavailable',
              'This agent could not be closed. Try again.'
            )
          )
        }
      })
    }
    return
  }
  if (tab) {
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'tab', worktreeId, tabId: tab.id }
    })
  } else if (state.tabsByWorktree[worktreeId]?.some((candidate) => candidate.id === tabId)) {
    closeTerminalTab(tabId, { reason: 'user' })
  } else {
    state.dropAgentStatus(agent.paneKey)
    state.dismissRetainedAgent(agent.paneKey)
  }
}
