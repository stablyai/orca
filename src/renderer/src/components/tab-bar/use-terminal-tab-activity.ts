import { useState } from 'react'
import { useAppStore } from '../../store'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
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

type ActivityStatusInput = Parameters<typeof resolveTerminalTabActivityStatus>[0]

/** One tab's status selector; store writes that leave this tab's inputs untouched reuse the last answer. */
function createActivityStatusSelector(): (input: ActivityStatusInput) => TerminalTabActivityStatus {
  let last: { input: ActivityStatusInput; status: TerminalTabActivityStatus } | null = null
  return (input) => {
    const previous = last?.input
    const { id } = input.tab
    if (
      last &&
      previous?.tab.id === id &&
      previous.tab.title === input.tab.title &&
      previous.tab.launchAgent === input.tab.launchAgent &&
      previous.agentStatusByPaneKey === input.agentStatusByPaneKey &&
      previous.agentStatusEpoch === input.agentStatusEpoch &&
      previous.runtimePaneTitlesByTabId?.[id] === input.runtimePaneTitlesByTabId?.[id] &&
      previous.ptyIdsByTabId?.[id] === input.ptyIdsByTabId?.[id] &&
      previous.terminalLayout?.root === input.terminalLayout?.root
    ) {
      return last.status
    }
    const status = resolveTerminalTabActivityStatus(input)
    last = { input, status }
    return status
  }
}

/** A terminal tab's status glyph and progress, as primitives so unrelated agent updates can't repaint it. */
export function useTerminalTabActivity(
  tab: Pick<TerminalTab, 'id' | 'title' | 'launchAgent'>
): TerminalTabActivity {
  // Every store write reruns this per mounted tab; skip title heuristics when this tab's inputs held.
  const [selectActivityStatus] = useState(createActivityStatusSelector)
  const activityStatus = useAppStore((s) =>
    selectActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
    })
  )
  const programProgress = useAppStore((s) =>
    resolveTerminalTabProgramProgress({
      tabId: tab.id,
      status: activityStatus,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch
    })
  )
  return { activityStatus, programProgress }
}
