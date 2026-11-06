import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAppStore } from '@/store'
import { applyRuntimePaneTitle } from '@/hooks/ipc-events/terminal-pane-title-ipc-bridge'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

export function renameSidebarAgent(agent: DashboardAgentRow, value: string): boolean {
  if (agent.rowSource === 'subagent') {
    return false
  }
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[agent.tab.worktreeId]?.find(
    (item) => item.id === agent.tab.id || item.entityId === agent.tab.id
  )
  if (!tab) {
    return false
  }
  const title = value.trim() || null
  if (tab.contentType === 'agent-session') {
    state.setTabCustomTitle(tab.id, title)
    return true
  }
  if (tab.contentType !== 'terminal') {
    return false
  }
  const layout = state.terminalLayoutsByTabId[tab.entityId]
  if (layout?.root?.type === 'split') {
    const pane = parsePaneKey(agent.paneKey)
    if (
      !pane ||
      pane.tabId !== tab.entityId ||
      !collectLeafIdsInOrder(layout.root).includes(pane.leafId)
    ) {
      return false
    }
    applyRuntimePaneTitle({ tabId: tab.entityId, leafId: pane.leafId, title })
  } else {
    state.setTabCustomTitle(tab.entityId, title)
  }
  return true
}
