import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'

type MockAgentOptions = {
  paneKey?: string
  tabId?: string
  agentType?: string
  rowSource?: DashboardAgentRowData['rowSource']
  state?: string
  startedAt?: number
  prompt?: string
  lastAssistantMessage?: string
  stateStartedAt?: number
  terminalHandle?: string
  orchestration?: {
    parentPaneKey?: string
    parentTerminalHandle?: string
    coordinatorHandle?: string
  }
  lineage?: {
    depth: number
    isFirstSibling: boolean
    isLastSibling: boolean
    childCount: number
  }
}

export function mockAgent({
  paneKey = 'tab-1:1',
  tabId = paneKey.split(':')[0],
  agentType,
  rowSource,
  state = 'working',
  startedAt,
  prompt,
  lastAssistantMessage,
  stateStartedAt = 1000,
  terminalHandle,
  orchestration,
  lineage
}: MockAgentOptions = {}): unknown {
  return {
    paneKey,
    tab: { id: tabId },
    agentType,
    rowSource,
    state,
    startedAt,
    entry: {
      prompt,
      lastAssistantMessage,
      state,
      stateStartedAt,
      stateHistory: prompt === undefined ? undefined : [],
      terminalHandle,
      orchestration
    },
    lineage
  }
}
