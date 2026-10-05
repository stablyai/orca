import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { isStructuredAgentSessionAsyncAnswer } from '../../../../shared/structured-agent-session-outbox-origin'
import { restoreNativeChatAsyncQuestionAnswers } from './native-chat-async-question-card-store'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

/**
 * Gives the sender back what a Stop withdrew: its text and images go into this pane's composer,
 * after whatever is there, and a card answer's answers go back to that card (keyed by the same
 * pane scope). Called before the entries leave storage, so a failure between the two repeats the
 * text rather than losing it. Only this client's outbox holds them, so no other viewer gets them.
 */
function restoreWithdrawnMessages(
  sessionId: string,
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (!composerScopeKey || withdrawn.length === 0) {
    return
  }
  // What the outbox no longer holds was already given back by whichever view dropped it first.
  const held = new Set(
    getStructuredAgentSessionOutbox(sessionId).map((entry) => entry.clientMessageId)
  )
  for (const entry of withdrawn) {
    if (!held.has(entry.clientMessageId)) {
      continue
    }
    // A card answer goes back to its card, never into the composer draft.
    if (entry.origin?.kind === 'async-answer') {
      restoreNativeChatAsyncQuestionAnswers(composerScopeKey, entry.origin.edits)
      continue
    }
    const blocks = entry.body.blocks
    appendNativeChatDraftCache(
      composerScopeKey,
      blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    )
    appendNativeChatAttachmentCache(
      composerScopeKey,
      blocks.flatMap((block, index) =>
        block.type === 'image-ref' && block.path
          ? [{ id: `withdrawn-${entry.clientMessageId}-${index}`, path: block.path }]
          : []
      )
    )
  }
}

export function useStructuredAgentSessionWithdrawnRestore(
  sessionId: string,
  /** Absent where no composer shows this session; the entries are then only dropped. */
  composerScopeKey: string | undefined
): {
  /** The entries the host settled as withdrawn by a Stop, and card answers it refused. */
  byHost: (
    entries: readonly StructuredAgentSessionOutboxEntry[],
    submissions: readonly AgentJournalSubmission[]
  ) => void
  /** Entries a Stop took out of the outbox here, before the host held them. */
  byStop: (entries: readonly StructuredAgentSessionOutboxEntry[]) => void
} {
  return useMemo(
    () => ({
      byHost: (entries, submissions) => {
        // A hand-off of a queued draft is never restored: the Stop that withdrew it put the draft
        // back as a card, which carries the text.
        const unsent = submissions.filter((submission) => submission.queuedMessageId === undefined)
        const withdrawn = new Set(
          unsent.filter(dispatchWasWithdrawn).map((submission) => submission.clientMessageId)
        )
        // A refused card answer leaves the outbox once its row loads; its answers go back too.
        const refused = new Set(
          unsent
            .filter((submission) => submission.dispatchState === 'rejected')
            .map((submission) => submission.clientMessageId)
        )
        restoreWithdrawnMessages(
          sessionId,
          composerScopeKey,
          entries.filter(
            (entry) =>
              withdrawn.has(entry.clientMessageId) ||
              (isStructuredAgentSessionAsyncAnswer(entry) && refused.has(entry.clientMessageId))
          )
        )
      },
      byStop: (entries) => restoreWithdrawnMessages(sessionId, composerScopeKey, entries)
    }),
    [composerScopeKey, sessionId]
  )
}
