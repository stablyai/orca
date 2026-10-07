import { useMemo } from 'react'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { appendNativeChatDraftCache, readNativeChatDraftCache } from './native-chat-draft-cache'
import {
  appendNativeChatAttachmentCache,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'
import type { StructuredAgentSessionSendDisposition } from '../../../../shared/structured-agent-session-send-disposition'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { agentSessionWriteNoticeParts } from '../../../../shared/agent-session-refusal-notice'

/** The host refused the message for an attachment it no longer stores: sending the same message
 *  again can never succeed, so only the sender can fix it. */
function attachmentExpiredRefusal(
  entry: StructuredAgentSessionOutboxEntry
): AgentSessionWriteRefusal | null {
  const failure = entry.lastFailure
  return failure?.kind === 'refused' &&
    failure.code === 'agent_session_operation_invalid' &&
    failure.details?.reason === 'attachmentExpired'
    ? failure
    : null
}

/** Puts a message's text and images into a composer, after whatever is there. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks']
): void {
  appendNativeChatDraftCache(
    composerScopeKey,
    blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  )
  appendNativeChatAttachmentCache(
    composerScopeKey,
    blocks.flatMap((block, index) =>
      block.type === 'image-ref' && block.path
        ? [{ id: `${attachmentIdPrefix}-${index}`, path: block.path }]
        : []
    )
  )
}

/**
 * Gives the sender back what its own Stop took out of the outbox before the host held it, into
 * an empty composer only: the host never had it, so the transcript cannot show it. Returns whether
 * they went in; a composer holding text or images keeps what is there, and the caller keeps the
 * entries. What the host withdrew stays in the transcript.
 */
function restoreUnsentMessages(
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  if (
    !composerScopeKey ||
    readNativeChatDraftCache(composerScopeKey) !== '' ||
    readNativeChatAttachmentCache(composerScopeKey).length > 0
  ) {
    return false
  }
  for (const entry of withdrawn) {
    returnMessageToComposer(
      composerScopeKey,
      `withdrawn-${entry.clientMessageId}`,
      entry.body.blocks
    )
  }
  return true
}

export function useStructuredAgentSessionWithdrawnRestore(
  /** Absent where no composer shows this session; the caller then keeps the entries. */
  composerScopeKey: string | undefined
): {
  /** Entries a Stop took out of the outbox here, before the host held them; false when the
   *  composer could not take them. */
  byStop: (entries: readonly StructuredAgentSessionOutboxEntry[]) => boolean
  /** A send's outcome, with any message refused for an expired attachment taken back out and
   *  returned to the composer, where the attachment can be removed, instead of held for a Retry
   *  that cannot succeed. Kept for Retry where no composer shows this session. */
  byRefusal: (
    disposition: StructuredAgentSessionSendDisposition
  ) => StructuredAgentSessionSendDisposition
} {
  return useMemo(
    () => ({
      byStop: (entries) => restoreUnsentMessages(composerScopeKey, entries),
      byRefusal: (disposition) => {
        const returned = disposition.entries.filter(
          (entry) => attachmentExpiredRefusal(entry) !== null
        )
        const refusal = returned[0] && attachmentExpiredRefusal(returned[0])
        if (!composerScopeKey || !refusal) {
          return disposition
        }
        // Only the send's own view applies its outcome, so nothing else gives these back.
        for (const entry of returned) {
          returnMessageToComposer(
            composerScopeKey,
            `withdrawn-${entry.clientMessageId}`,
            entry.body.blocks
          )
        }
        return {
          entries: disposition.entries.filter((entry) => !returned.includes(entry)),
          error: agentSessionWriteNoticeParts(refusal, 'send')
        }
      }
    }),
    [composerScopeKey]
  )
}
