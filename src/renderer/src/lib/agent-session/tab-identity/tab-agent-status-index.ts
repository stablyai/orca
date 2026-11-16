import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'
export type TabAgentPane = { readonly leafId: string; readonly agent: TerminalAgent }

export function selectLiveTabAgentPanes(
  statuses: AcceptedAgentStatuses,
  tabId: string
): readonly TabAgentPane[] {
  return statuses.projection.tabPanes(tabId, false)
}
export function selectCompletedTabAgentPanes(
  statuses: AcceptedAgentStatuses,
  tabId: string
): readonly TabAgentPane[] {
  return statuses.projection.tabPanes(tabId, true)
}
export function firstTabAgentExcludingLeaf(
  panes: readonly TabAgentPane[],
  excludedLeafId?: string
): TerminalAgent | null {
  for (const pane of panes) {
    if (pane.leafId !== excludedLeafId) {
      return pane.agent
    }
  }
  return null
}
