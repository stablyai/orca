import { useState } from 'react'
import { useAppStore } from '../../../store/index'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { getPaneForegroundAgentsByTabId } from '@/components/sidebar/workspace-card/activity/worktree-card-status-inputs'
import {
  getTerminalTabActivityFlags,
  resolveTerminalTabActivityStatus,
  resolveTerminalTabProgramProgress,
  type TerminalTabActivityFlags,
  type TerminalTabActivityStatus
} from './terminal-tab-activity-status'

type TerminalTabActivity = {
  activityStatus: TerminalTabActivityStatus
  /** Program-reported 0–100 from the pane driving `activityStatus`, if it reports one. */
  programProgress: number | undefined
}

type ActivityStatusInput = Parameters<typeof resolveTerminalTabActivityStatus>[0]
type TabForegroundEntries = ReturnType<ReturnType<typeof getPaneForegroundAgentsByTabId>['get']>

// Why: the foreground map gets a new identity on any pane's write; compare only this tab's entries.
function sameTabForegroundEntries(a: TabForegroundEntries, b: TabForegroundEntries): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b || a.length !== b.length) {
    return false
  }
  return a.every(([paneKey, entry], index) => paneKey === b[index][0] && entry === b[index][1])
}

/** One tab's status selector; store writes that leave this tab's inputs untouched reuse the last answer. */
function createActivityStatusSelector(): (input: ActivityStatusInput) => TerminalTabActivityStatus {
  let last: {
    tabId: string
    title: string
    launchAgent: ActivityStatusInput['tab']['launchAgent']
    flags: TerminalTabActivityFlags | undefined
    paneTitles: Record<number, string> | undefined
    ptyIds: string[] | undefined
    layoutRoot: NonNullable<ActivityStatusInput['terminalLayout']>['root'] | undefined
    foreground: TabForegroundEntries
    status: TerminalTabActivityStatus
  } | null = null
  return (input) => {
    const { id } = input.tab
    const flags = getTerminalTabActivityFlags(
      input.agentStatusByPaneKey,
      input.agentStatusEpoch
    ).get(id)
    const foreground = input.paneForegroundAgentByPaneKey
      ? getPaneForegroundAgentsByTabId(input.paneForegroundAgentByPaneKey).get(id)
      : undefined
    if (
      last &&
      last.tabId === id &&
      last.title === input.tab.title &&
      last.launchAgent === input.tab.launchAgent &&
      last.flags === flags &&
      last.paneTitles === input.runtimePaneTitlesByTabId?.[id] &&
      last.ptyIds === input.ptyIdsByTabId?.[id] &&
      last.layoutRoot === input.terminalLayout?.root &&
      sameTabForegroundEntries(last.foreground, foreground)
    ) {
      return last.status
    }
    const status = resolveTerminalTabActivityStatus({
      ...input,
      paneForegroundAgentByPaneKey: foreground ? Object.fromEntries(foreground) : undefined
    })
    last = {
      tabId: id,
      title: input.tab.title,
      launchAgent: input.tab.launchAgent,
      flags,
      paneTitles: input.runtimePaneTitlesByTabId?.[id],
      ptyIds: input.ptyIdsByTabId?.[id],
      layoutRoot: input.terminalLayout?.root,
      foreground,
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
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id],
      paneForegroundAgentByPaneKey: s.paneForegroundAgentByPaneKey
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
