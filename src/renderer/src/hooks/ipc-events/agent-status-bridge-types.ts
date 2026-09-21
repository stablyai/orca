import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { AgentStatusBatchTransaction } from '@/store/slices/agent-status'
import type { AgentStatusPaneRoutingIndex } from './agent-status-pane-routing-index'

export type PendingAgentStatusEvent = {
  data: AgentStatusIpcPayload
  firstSeenAt: number
  replay: boolean
}

export type AgentStatusApplyResult = 'applied' | 'pending' | 'dropped'

type ProjectedAgentTabTitles = {
  title: string | undefined
  identityTitle: string | undefined
}

export type AgentStatusBatchContext = {
  transaction: AgentStatusBatchTransaction
  routingIndex: AgentStatusPaneRoutingIndex
  projectedTitlesByTabId: Map<string, ProjectedAgentTabTitles>
  tabTitlesByTabId: Map<string, string>
  notificationEffects: (() => void)[]
}

export type AgentStatusBatchEvent = {
  data: AgentStatusIpcPayload
  replay?: boolean
  retry?: boolean
}

export type AgentStatusApplyOptions = {
  replay?: boolean
  retry?: boolean
  batch?: AgentStatusBatchContext
}
