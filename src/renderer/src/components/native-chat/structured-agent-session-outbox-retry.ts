import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { transitionOutbox } from './structured-agent-session-outbox-transitions'

export function retryOutboxEntry(
  sessionId: string,
  clientMessageId: string,
  submission: AgentJournalSubmission | undefined,
  createOperationId: () => string
): boolean {
  return transitionOutbox(sessionId, (entries) =>
    entries.map((entry) => {
      if (entry.clientMessageId !== clientMessageId) {
        return entry
      }
      // A settled rejection only replays forever; explicit Retry needs a new operation.
      if (submission?.dispatchState === 'rejected') {
        return {
          ...entry,
          clientMessageId: createOperationId(),
          recovery: undefined,
          dispatchBlocked: false,
          state: 'queued' as const,
          retryAfterUnknownSubmittedAt: null
        }
      }
      return {
        ...entry,
        state: 'queued' as const,
        dispatchBlocked: false,
        deliveryIncarnation: (entry.deliveryIncarnation ?? 0) + 1,
        retryAfterUnknownSubmittedAt:
          submission?.dispatchState === 'unknown'
            ? submission.submittedAt
            : entry.state === 'unconfirmed'
              ? -1
              : null
      }
    })
  ).ok
}
