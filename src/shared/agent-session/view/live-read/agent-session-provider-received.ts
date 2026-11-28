import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
import { agentJournalSubmissionKey } from '../../journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'

// Claude's MAX_ACTIVE_DISPATCH_WAITERS and Codex's pending dispatch echo cap.
export const MAX_AGENT_SESSION_PROVIDER_RECEIPTS = 64

export function providerReceivedAfterBatch(
  previous: ReadonlyMap<string, number> | undefined,
  event: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>,
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, number> | undefined {
  const received = event.providerReceived
  if (!received?.length && !previous?.size) {
    return undefined
  }
  if (
    !received?.length &&
    !event.batch.submissions.length &&
    !event.batch.removedItemIds.length &&
    !event.batch.items.some((item) => item.body.kind === 'message' && item.body.role === 'user')
  ) {
    return previous
  }
  const pending = new Set(
    submissions.flatMap((submission) =>
      submission.dispatchState === 'pending'
        ? [agentJournalSubmissionKey(submission.clientMessageId)]
        : []
    )
  )
  const candidates = new Set(received?.slice(0, MAX_AGENT_SESSION_PROVIDER_RECEIPTS))
  const next = new Map<string, number>()
  for (const { itemId, sequence } of items) {
    if ((previous?.get(itemId) === sequence || candidates.has(sequence)) && pending.has(itemId)) {
      next.set(itemId, sequence)
      if (next.size === MAX_AGENT_SESSION_PROVIDER_RECEIPTS) {
        break
      }
    }
  }
  return next.size === 0
    ? undefined
    : previous?.size === next.size &&
        [...next].every(([id, sequence]) => previous.get(id) === sequence)
      ? previous
      : next
}
