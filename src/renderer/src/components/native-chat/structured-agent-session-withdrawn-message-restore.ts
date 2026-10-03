import { useMemo } from 'react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { appendNativeChatDraftCache, readNativeChatDraftCache } from './native-chat-draft-cache'
import {
  appendNativeChatAttachmentCache,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

/**
 * Gives the sender back what its own Stop took out of the outbox before the host held it, into
 * an empty composer only: the host never had it, so the transcript cannot show it. A composer
 * holding text or images keeps what is there. What the host withdrew stays in the transcript.
 */
function restoreUnsentMessages(
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (
    !composerScopeKey ||
    withdrawn.length === 0 ||
    readNativeChatDraftCache(composerScopeKey) !== '' ||
    readNativeChatAttachmentCache(composerScopeKey).length > 0
  ) {
    return
  }
  for (const entry of withdrawn) {
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
  /** Absent where no composer shows this session; the entries are then only dropped. */
  composerScopeKey: string | undefined
): {
  /** Entries a Stop took out of the outbox here, before the host held them. */
  byStop: (entries: readonly StructuredAgentSessionOutboxEntry[]) => void
} {
  return useMemo(
    () => ({ byStop: (entries) => restoreUnsentMessages(composerScopeKey, entries) }),
    [composerScopeKey]
  )
}
