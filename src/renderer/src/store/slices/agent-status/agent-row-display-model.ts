import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

import type { AgentDotState } from '@/components/AgentStateDot'
import type { KeyedDeadlines } from '../../../../../shared/keyed-deadlines'

export const EMPTY_KEYS: readonly string[] = Object.freeze([])

export type AgentGroupSummary = {
  state: AgentDotState
  count: number
  icons: Pick<DashboardAgentRow, 'paneKey' | 'agentType'>[]
  identities: { agentType: DashboardAgentRow['agentType']; count: number }[]
}

export type AgentChildren = {
  keys: readonly string[]
  active: readonly string[]
  idle: readonly string[]
  signal?: AgentDotState
}

export const EMPTY_CHILDREN: AgentChildren = {
  keys: EMPTY_KEYS,
  active: EMPTY_KEYS,
  idle: EMPTY_KEYS
}

export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

export function sameChildren(a: AgentChildren, b: AgentChildren): boolean {
  return (
    a.signal === b.signal &&
    sameKeys(a.keys, b.keys) &&
    sameKeys(a.active, b.active) &&
    sameKeys(a.idle, b.idle)
  )
}

export type Group = Map<string, KeyedDeadlines>

export type Placement = {
  owner: string
  rank: number
  parent?: string
  state: AgentDotState
  agentType: DashboardAgentRow['agentType']
}
