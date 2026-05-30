import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'

function getPaneKeyTabId(paneKey: AgentStatusEntry['paneKey']): string {
  const separatorIndex = paneKey.lastIndexOf(':')
  return separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
}

export function hasFreshLiveAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabIds: Set<string>,
  now: number
): boolean {
  return Object.values(agentStatusByPaneKey).some(
    (entry) =>
      tabIds.has(getPaneKeyTabId(entry.paneKey)) &&
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) &&
      (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting')
  )
}

export function hasWorkingTitleAgent(
  tabs: { id: string; title: string }[],
  ptyIdsByTabId: Record<string, string[]>,
  runtimePaneTitlesByTabId: Record<string, Record<string, string>>
): boolean {
  for (const tab of tabs) {
    if ((ptyIdsByTabId[tab.id]?.length ?? 0) === 0) {
      continue
    }
    const paneTitles = runtimePaneTitlesByTabId[tab.id]
    const titles =
      paneTitles && Object.keys(paneTitles).length > 0 ? Object.values(paneTitles) : [tab.title]
    for (const title of titles) {
      const status = detectAgentStatusFromTitle(title)
      if (status === 'working' || status === 'permission') {
        return true
      }
    }
  }
  return false
}
