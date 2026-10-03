import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { useAppStore } from '../../store'
import { appendNativeChatDraftNow, type NativeChatDraftAttachment } from './native-chat-draft-cache'
import {
  resolveNativeChatAttachmentOwnerForWorktree,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'

/**
 * Gives the sender back what a Stop withdrew: its text and images go into this pane's composer,
 * after whatever is there. Called before the entries leave storage, so a failure between the two
 * repeats the text rather than losing it. Only this client's outbox holds them, so no other viewer
 * gets them.
 */
function restoreWithdrawnMessages(
  sessionId: string,
  composerScopeKey: string | undefined,
  composerWorktreeId: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (!composerScopeKey || withdrawn.length === 0) {
    return
  }
  const where = withdrawnImageLocation(composerWorktreeId)
  // What the outbox no longer holds was already given back by whichever view dropped it first.
  const held = new Set(
    getStructuredAgentSessionOutbox(sessionId).map((entry) => entry.clientMessageId)
  )
  for (const entry of withdrawn) {
    if (!held.has(entry.clientMessageId)) {
      continue
    }
    const blocks = entry.body.blocks
    void appendNativeChatDraftNow(composerScopeKey, {
      text: blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
      attachments: blocks.flatMap((block, index) =>
        block.type === 'image-ref' && block.path
          ? [{ id: `withdrawn-${entry.clientMessageId}-${index}`, path: block.path, ...where }]
          : []
      )
    })
  }
}

/** The outbox keeps only an image's path; it lives where this chat's new images do. */
function withdrawnImageLocation(
  worktreeId: string | undefined
): Pick<NativeChatDraftAttachment, 'connectionId' | 'location'> {
  const owner: NativeChatAttachmentOwner = worktreeId
    ? resolveNativeChatAttachmentOwnerForWorktree(useAppStore.getState(), worktreeId)
    : { kind: 'not-ready' }
  switch (owner.kind) {
    case 'local':
      return { location: 'local' }
    case 'ssh':
      return { connectionId: owner.connectionId, location: 'ssh' }
    case 'runtime':
      return { location: 'runtime' }
    case 'not-ready':
      // Left unknown, so the chip is never wrongly marked missing.
      return {}
  }
}

export function useStructuredAgentSessionWithdrawnRestore(
  sessionId: string,
  /** Absent where no composer shows this session; the entries are then only dropped. */
  composerScopeKey: string | undefined,
  composerWorktreeId?: string
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
        // A hand-off of a queued draft is never restored: the Stop that withdrew it put the draft
        // back as a card, which carries the text.
        const withdrawn = new Set(
          submissions
            .filter(
              (submission) =>
                dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
            )
            .map((submission) => submission.clientMessageId)
        )
        restoreWithdrawnMessages(
          sessionId,
          composerScopeKey,
          composerWorktreeId,
          entries.filter((entry) => withdrawn.has(entry.clientMessageId))
        )
      },
      byStop: (entries) =>
        restoreWithdrawnMessages(sessionId, composerScopeKey, composerWorktreeId, entries)
    }),
    [composerScopeKey, composerWorktreeId, sessionId]
  )
}
