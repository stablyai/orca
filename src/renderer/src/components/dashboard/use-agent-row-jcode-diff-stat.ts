import { useMemo } from 'react'
import { getJcodeTitleDiffStat, type JcodeDiffStat } from '../../../../shared/jcode-terminal-title'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { resolveAgentRowPaneLiveTitle } from './agent-row-pane-live-title'
import { agentRowCannotOwnTabTitle, getIndexedTab } from './use-agent-row-conversation-name'
import { useAppStore } from '@/store'
import type { DashboardAgentRow } from './useDashboardData'

export function useAgentRowJcodeDiffStat(agent: DashboardAgentRow): JcodeDiffStat | null {
  const cannotOwnTitle =
    agent.agentType !== 'jcode' || agentRowCannotOwnTabTitle(agent) || Boolean(agent.childRow)
  const ownLeafId = cannotOwnTitle ? null : parsePaneKey(agent.paneKey)?.leafId
  const liveTitle = useAppStore((s) => {
    if (cannotOwnTitle) {
      return null
    }
    const tab = getIndexedTab(s.tabsByWorktree[agent.tab.worktreeId], agent.tab.id)
    if (!tab) {
      return null
    }
    const paneTitle = resolveAgentRowPaneLiveTitle(
      s.terminalLayoutsByTabId?.[agent.tab.id],
      s.runtimePaneTitlesByTabId?.[agent.tab.id],
      ownLeafId
    )
    // Stored entry titles can belong to a sibling pane; only this pane's live title is safe.
    return paneTitle === undefined ? tab.title : paneTitle
  })
  return useMemo(() => getJcodeTitleDiffStat(liveTitle), [liveTitle])
}
