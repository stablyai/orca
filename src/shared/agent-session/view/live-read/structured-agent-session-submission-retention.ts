import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../journal/agent-session-journal-types'
import type { AgentSessionHistoryPage, AgentSessionJournalBatch } from '../../agent-session-wire'
import type { StructuredAgentSessionState } from './structured-agent-session-reducer'
import { mergeSubmissions } from '../structured-agent-session-item-retention'
import {
  applySubmissionReceipts,
  materializeStructuredAgentSubmissions,
  splitStructuredAgentSubmissions,
  structuredAgentSubmissionIndex,
  type StructuredAgentSubmission,
  type StructuredAgentSubmissions
} from '../structured-agent-session-submissions'

// A history page can see newer facts than the stream has received. Keep that watermark
// only for retained submissions observed in those pages, until the stream can supersede them.
const pageSequences = new WeakMap<
  readonly StructuredAgentSubmission[],
  ReadonlyMap<string, number>
>()

export function mergeStructuredAgentSubmissions(
  state: StructuredAgentSubmissions,
  incoming: readonly AgentJournalSubmission[],
  items: readonly AgentJournalRenderItem[],
  supersededThrough?: number,
  pageSequence?: number
): StructuredAgentSubmissions {
  const merged = splitStructuredAgentSubmissions(
    mergeSubmissions(materializeStructuredAgentSubmissions(state), incoming, items)
  )
  const previous = pageSequences.get(state.submissions)
  if (previous || pageSequence !== undefined) {
    const retained = structuredAgentSubmissionIndex(merged.submissions)
    const watermarks = new Map<string, number>()
    for (const [id, sequence] of previous ?? []) {
      if (retained.has(id) && sequence > (supersededThrough ?? -1)) {
        watermarks.set(id, sequence)
      }
    }
    if (pageSequence !== undefined) {
      for (const { clientMessageId } of incoming) {
        if (retained.has(clientMessageId)) {
          watermarks.set(clientMessageId, pageSequence)
        }
      }
    }
    if (watermarks.size > 0) {
      pageSequences.set(merged.submissions, watermarks)
    }
  }
  return merged
}

export function olderPageSubmissions(
  state: StructuredAgentSessionState,
  page: AgentSessionHistoryPage,
  items: readonly AgentJournalRenderItem[]
): StructuredAgentSubmissions {
  const pageSequence = page.liveCursor?.sequence
  const streamSequence = state.cursor?.sequence ?? -1
  const index = structuredAgentSubmissionIndex(state.submissions)
  const watermarks = pageSequences.get(state.submissions)
  const incoming = page.submissions.filter(
    ({ clientMessageId: id }) =>
      !index.has(id) ||
      (pageSequence !== undefined &&
        pageSequence >= Math.max(streamSequence, watermarks?.get(id) ?? -1))
  )
  return mergeStructuredAgentSubmissions(
    state,
    incoming,
    items,
    streamSequence,
    pageSequence !== undefined && pageSequence > streamSequence ? pageSequence : undefined
  )
}

export function liveSubmissions(
  state: StructuredAgentSubmissions,
  { submissions, removedItemIds, cursor }: AgentSessionJournalBatch,
  items: readonly AgentJournalRenderItem[],
  itemsUnchanged: boolean
): StructuredAgentSubmissions {
  const watermarks = pageSequences.get(state.submissions)
  const authoritative = watermarks
    ? submissions.filter(
        ({ clientMessageId }) => cursor.sequence >= (watermarks.get(clientMessageId) ?? -1)
      )
    : submissions
  if (authoritative.length === 0 && removedItemIds.length === 0) {
    return { submissions: state.submissions, writtenAtById: state.writtenAtById }
  }
  return (
    (itemsUnchanged && applySubmissionReceipts(state, authoritative)) ||
    mergeStructuredAgentSubmissions(state, authoritative, items, cursor.sequence)
  )
}
