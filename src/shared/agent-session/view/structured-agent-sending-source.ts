import { structuredAgentSessionSendingItemIds } from './structured-agent-session-sending'
import type {
  StructuredAgentSubmission,
  SubmissionReceipts
} from './structured-agent-session-submissions'

export type SubmissionReceiptSource = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SubmissionReceipts
}

const NO_RECEIPTS: SubmissionReceipts = new Map()

export function createStructuredAgentSendingSource(
  receipts: SubmissionReceiptSource,
  pending: readonly { clientMessageId: string; phase?: string }[],
  submissions: readonly StructuredAgentSubmission[]
) {
  const candidates = structuredAgentSessionSendingItemIds(pending, submissions, NO_RECEIPTS)
  let previousReceipts: SubmissionReceipts = NO_RECEIPTS
  let sending = candidates
  return {
    subscribe: receipts.subscribe,
    candidates,
    getSnapshot() {
      const next = receipts.getSnapshot()
      if (next !== previousReceipts) {
        sending = structuredAgentSessionSendingItemIds(pending, submissions, next)
        previousReceipts = next
      }
      return sending
    }
  }
}

export type StructuredAgentSendingSource = ReturnType<typeof createStructuredAgentSendingSource>

export function structuredAgentDisplayedSendPending(
  source: StructuredAgentSendingSource | undefined,
  isDisplayed: (id: string) => boolean
): boolean {
  if (source) {
    for (const id of source.getSnapshot()) {
      if (isDisplayed(id)) {
        return true
      }
    }
  }
  return false
}
