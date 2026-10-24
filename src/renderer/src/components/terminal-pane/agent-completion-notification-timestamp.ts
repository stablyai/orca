import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'

export function selectHookNotificationTimestamp(
  payload: AgentCompletionStatusSnapshot
): number | undefined {
  if (typeof payload.turnCompletedAt === 'number' && Number.isFinite(payload.turnCompletedAt)) {
    return payload.turnCompletedAt
  }
  if (
    payload.state === 'done' &&
    typeof payload.turnEndedAt === 'number' &&
    Number.isFinite(payload.turnEndedAt)
  ) {
    return payload.turnEndedAt
  }
  return payload.stateStartedAt
}
