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

/**
 * Project a row state onto the published card vocabulary.
 *
 * `unverifiable` stays renderer-local: `DashboardCardDotState` is validated against a fixed
 * allowlist in main (`dashboard-payload-validation.ts`) and read by pop-out windows that may
 * predate the member, so a new value would be dropped rather than rendered. Publishing today's
 * `idle` keeps those surfaces at today's behavior instead of silently losing the card.
 */
export function dashboardCardDotState(state: AgentRowState): DashboardCardDotState {
  return state === 'unverifiable' ? 'idle' : state
}

/** The store slices the agent-row unread rule reads. */
export type AgentRowUnreadState = {
  agentStatusByPaneKey: AgentAttentionTurnRecords['liveTurns']
  retainedAgentsByPaneKey: AgentAttentionTurnRecords['retainedTurns']
  acknowledgedAgentsByPaneKey: AgentAttentionTurnRecords['acknowledgedTurnStartedAt']
}

/**
 * The records behind the one unread (bold) rule for an agent row, on every surface that draws one:
 * `isAgentSubjectUnread(records, row.paneKey)`.
 *
 * Why the store's turn records, not the row: auto-acknowledgement clears exactly these, so a row
 * is bold only while viewing or clicking it can clear it. Rows built from a terminal title, a
 * subagent or a migration block have no record and are never unread.
 */
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

/** Derive the shared dashboard presentation state for one agent row. */
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
