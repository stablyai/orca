import type { DashboardAgentRow } from './useDashboardData'
import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCardDotState
} from '../../../../shared/dashboard-snapshot'
import { dashboardBucketForDotState } from './dashboard-card-bucket'
import type { AgentRowState } from '../../../../shared/agent-row-decay-state'
import {
  isAgentSubjectUnread,
  type AgentAttentionTurnRecords
} from '@/attention/agent-attention-acknowledgement'

/** Publish unverifiable as idle for fixed main validators and older pop-outs; unknown dot states would drop the card. */
export function dashboardCardDotState(state: AgentRowState): DashboardCardDotState {
  return state === 'unverifiable' ? 'idle' : state
}

export type AgentRowUnreadState = {
  agentStatusByPaneKey: AgentAttentionTurnRecords['liveTurns']
  retainedAgentsByPaneKey: AgentAttentionTurnRecords['retainedTurns']
  acknowledgedAgentsByPaneKey: AgentAttentionTurnRecords['acknowledgedTurnStartedAt']
}

/** Unread reads live/retained turn records that acknowledgment can clear; synthetic title/subagent/migration rows have no record and stay read. */
export function readAgentRowTurnRecords(state: AgentRowUnreadState): AgentAttentionTurnRecords {
  return {
    liveTurns: state.agentStatusByPaneKey,
    retainedTurns: state.retainedAgentsByPaneKey,
    acknowledgedTurnStartedAt: state.acknowledgedAgentsByPaneKey
  }
}

export type DashboardRowBucketProjection = {
  isTitleDerived: boolean
  dotState: DashboardCardDotState
  workingMode: DashboardAgentRow['entry']['workingMode']
  unseen: boolean
  bucket: DashboardBucket
}

export function dashboardRowBucketProjection(
  row: Pick<DashboardAgentRow, 'paneKey' | 'entry' | 'state' | 'startedAt'>,
  turnRecords: AgentAttentionTurnRecords
): DashboardRowBucketProjection {
  const isTitleDerived = row.startedAt === 0
  const dotState = dashboardCardDotState(row.state)
  const workingMode =
    row.state === 'working' && row.entry.workingMode === 'monitoring'
      ? row.entry.workingMode
      : undefined
  const unseen = isAgentSubjectUnread(turnRecords, row.paneKey)
  const bucket = dashboardBucketForDotState(
    dashboardCardDisplayState({ dotState, workingMode, unseen })
  )

  return { isTitleDerived, dotState, workingMode, unseen, bucket }
}
