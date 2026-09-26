import type { DashboardAgentRow } from './useDashboardData'
import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCardDotState
} from '../../../../shared/dashboard-snapshot'
import { dashboardBucketForDotState } from './dashboard-card-bucket'
import type { AgentRowState } from '@/lib/agent-row-decay-state'

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
  acknowledgedAgentsByPaneKey?: Record<string, number>
): DashboardRowBucketProjection {
  const isTitleDerived = row.startedAt === 0
  const dotState = dashboardCardDotState(row.state)
  const workingMode =
    row.state === 'working' && row.entry.workingMode === 'monitoring'
      ? row.entry.workingMode
      : undefined
  const unseen =
    !isTitleDerived && (acknowledgedAgentsByPaneKey?.[row.paneKey] ?? 0) < row.entry.stateStartedAt
  const bucket = dashboardBucketForDotState(
    dashboardCardDisplayState({ dotState, workingMode, unseen })
  )

  return { isTitleDerived, dotState, workingMode, unseen, bucket }
}
