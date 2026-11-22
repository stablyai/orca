import { useState } from 'react'
import { useAppStore } from '../../../store/index'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import {
  getTerminalTabActivityFlags,
  resolveTerminalTabActivityGlyph,
  resolveTerminalTabProgramProgress,
  type TerminalTabActivityFlags,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'

type TerminalTabActivity = {
  activityStatus: TerminalTabActivityStatus
  /** The tab needs you while an agent in it keeps working. */
  asking: boolean
  /** Program-reported 0–100 from the pane driving `activityStatus`, if it reports one. */
  programProgress: number | undefined
}

type ActivityStatusInput = Parameters<typeof resolveTerminalTabActivityGlyph>[0]
type ActivityGlyph = ReturnType<typeof resolveTerminalTabActivityGlyph>

/** One tab's status selector; store writes that leave this tab's inputs untouched reuse the last answer. */
function createActivityStatusSelector(): (input: ActivityStatusInput) => ActivityGlyph {
  let last: {
    tabId: string
    title: string
    launchAgent: ActivityStatusInput['tab']['launchAgent']
    flags: TerminalTabActivityFlags | undefined
    paneTitles: Record<number, string> | undefined
    ptyIds: string[] | undefined
    layoutRoot: NonNullable<ActivityStatusInput['terminalLayout']>['root'] | undefined
    status: ActivityGlyph
  } | null = null
  return (input) => {
    const { id } = input.tab
    const flags = getTerminalTabActivityFlags(
      input.agentStatusByPaneKey,
      input.agentStatusEpoch
    ).get(id)
    if (
      last &&
      last.tabId === id &&
      last.title === input.tab.title &&
      last.launchAgent === input.tab.launchAgent &&
      last.flags === flags &&
      last.paneTitles === input.runtimePaneTitlesByTabId?.[id] &&
      last.ptyIds === input.ptyIdsByTabId?.[id] &&
      last.layoutRoot === input.terminalLayout?.root
    ) {
      return last.status
    }
    const status = resolveTerminalTabActivityGlyph(input)
    last = {
      tabId: id,
      title: input.tab.title,
      launchAgent: input.tab.launchAgent,
      flags,
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
  const glyph = useAppStore((s) =>
    selectActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
    })
  )
  const asking = glyph === 'asking'
  const activityStatus = glyph === 'asking' ? 'permission' : glyph
  const programProgress = useAppStore((s) =>
    resolveTerminalTabProgramProgress({
      tabId: tab.id,
      status: activityStatus,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch
    })
  )
  return { activityStatus, asking, programProgress }
}
