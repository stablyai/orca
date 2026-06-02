import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../../shared/types'
import { getTabAgentActivity, type TabAgentActivity } from './tab-agent-activity'

export function useTerminalTabAgentActivity(tab: TerminalTab): TabAgentActivity {
  return useAppStore((s) =>
    getTabAgentActivity({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId
    })
  )
}
