import { useAgentStatusSelector } from '@/store/agent-status'
import '../../store'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resolveTerminalTabActivityStatus,
  resolveTerminalTabProgramProgress,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'

type TerminalTabActivity = {
  activityStatus: TerminalTabActivityStatus
  /** Program-reported 0–100 from the pane driving `activityStatus`, if it reports one. */
  programProgress: number | undefined
}

/** A terminal tab's status glyph and progress, as primitives so unrelated agent updates can't repaint it. */
export function useTerminalTabActivity(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
): TerminalTabActivity {
  // Pane bucketing is memoized per snapshot, so every mounted tab shares one pass.
  const activityStatus = useAgentStatusSelector(
    (s) =>
      resolveTerminalTabActivityStatus({
        tab,
        agentStatusByPaneKey: s.agentStatusByPaneKey,
        agentStatusEpoch: s.agentStatusEpoch,
        runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
        ptyIdsByTabId: s.ptyIdsByTabId,
        terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
      }),
    undefined,
    tab.id
  )
  const programProgress = useAgentStatusSelector(
    (s) =>
      resolveTerminalTabProgramProgress({
        tabId: tab.id,
        status: activityStatus,
        agentStatusByPaneKey: s.agentStatusByPaneKey,
        agentStatusEpoch: s.agentStatusEpoch
      }),
    undefined,
    tab.id
  )
  return { activityStatus, programProgress }
}
