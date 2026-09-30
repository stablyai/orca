import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { readOutbox } from './structured-agent-session-outbox-storage'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

/**
 * Gives the sender back what a Stop withdrew: its text and images go into this pane's composer,
 * after whatever is there. Called before the entries leave storage, so a failure between the two
 * repeats the text rather than losing it. Only this client's outbox holds them, so no other viewer
 * gets them.
 */
function restoreWithdrawnMessages(
  sessionId: string,
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (!composerScopeKey || withdrawn.length === 0) {
    return
  }
  // What storage no longer holds was already given back by whichever view dropped it first.
  const held = new Set(
    readOutbox(sessionId, { recoverDispatching: false }).map((entry) => entry.clientMessageId)
  )
  for (const entry of withdrawn) {
    if (!held.has(entry.clientMessageId)) {
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
  /** The entries the host settled as withdrawn by a Stop. */
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
        const withdrawn = new Set(
          submissions.filter(dispatchWasWithdrawn).map((submission) => submission.clientMessageId)
        )
        restoreWithdrawnMessages(
          sessionId,
          composerScopeKey,
          entries.filter((entry) => withdrawn.has(entry.clientMessageId))
        )
      },
      byStop: (entries) => restoreWithdrawnMessages(sessionId, composerScopeKey, entries)
    }),
    [composerScopeKey, sessionId]
  )
}
