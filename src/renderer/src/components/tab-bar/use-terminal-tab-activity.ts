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
  let last: {
    tabId: string
    title: string
    launchAgent: ActivityStatusInput['tab']['launchAgent']
    agentStatusByPaneKey: ActivityStatusInput['agentStatusByPaneKey']
    agentStatusEpoch: ActivityStatusInput['agentStatusEpoch']
    paneTitles: Record<number, string> | undefined
    ptyIds: string[] | undefined
    layoutRoot: NonNullable<ActivityStatusInput['terminalLayout']>['root'] | undefined
    status: TerminalTabActivityStatus
  } | null = null
  return (input) => {
    const { id } = input.tab
    if (
      last &&
      last.tabId === id &&
      last.title === input.tab.title &&
      last.launchAgent === input.tab.launchAgent &&
      last.agentStatusByPaneKey === input.agentStatusByPaneKey &&
      last.agentStatusEpoch === input.agentStatusEpoch &&
      last.paneTitles === input.runtimePaneTitlesByTabId?.[id] &&
      last.ptyIds === input.ptyIdsByTabId?.[id] &&
      last.layoutRoot === input.terminalLayout?.root
    ) {
      return last.status
    }
    const status = resolveTerminalTabActivityStatus(input)
    last = {
      tabId: id,
      title: input.tab.title,
      launchAgent: input.tab.launchAgent,
      agentStatusByPaneKey: input.agentStatusByPaneKey,
      agentStatusEpoch: input.agentStatusEpoch,
      paneTitles: input.runtimePaneTitlesByTabId?.[id],
      ptyIds: input.ptyIdsByTabId?.[id],
      layoutRoot: input.terminalLayout?.root,
      status
    }
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
