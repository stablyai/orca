import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import type { OwnedPaneAgentRecord } from './agent-session-resume'

/** Transient process and accepted-source condition; never saved with a pane. */
export type PaneSleepTarget = {
  paneKey: string
  ptyId: string
  ptyIncarnationId: string
  authorityGeneration: string
  sourceUpdatedAt?: number
}
export type PaneSleepStopCondition = {
  workspace: string
  target: PaneSleepTarget
  record?: OwnedPaneAgentRecord
}
export function paneSleepSourceIsCurrent(
  target: PaneSleepTarget,
  row: AgentStatusEntry | null | undefined
): boolean {
  return !row || (target.sourceUpdatedAt !== undefined && row.updatedAt <= target.sourceUpdatedAt)
}
