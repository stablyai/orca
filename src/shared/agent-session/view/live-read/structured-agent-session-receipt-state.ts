import type {
  StructuredAgentSessionAction,
  StructuredAgentSessionState
} from './structured-agent-session-reducer'

/** Keep transport progress and clock samples private when receipt delivery is the only change. */
export function isStructuredAgentSessionReceiptUpdate(
  previous: StructuredAgentSessionState,
  next: StructuredAgentSessionState,
  action: StructuredAgentSessionAction
): boolean {
  if (
    action.type !== 'event' ||
    action.opensSubscription ||
    action.event.type !== 'batch' ||
    action.event.batch.submissions.length === 0 ||
    action.event.batch.items.length > 0 ||
    action.event.batch.removedItemIds.length > 0
  ) {
    return false
  }
  const prior: Readonly<Record<string, unknown>> = previous
  return Object.entries(next).every(
    ([field, value]) =>
      field === 'cursor' ||
      field === 'hostClock' ||
      field === 'writtenAtById' ||
      value === prior[field]
  )
}
