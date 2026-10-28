import { nativeChatMessageCopyText } from '../../../../shared/native-chat-message-copy-text'
import { nativeChatStoppedBeforeStartLabel } from './native-chat-stopped-before-start-row'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** The copy text of the transcript row drawing `messageId`, or null when no row draws it. */
export function nativeChatSlotCopyText(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string
): string | null {
  const slot = slots.find((entry) => entry.kind === 'message' && entry.message.id === messageId)
  return slot?.kind === 'message'
    ? nativeChatMessageCopyText(slot.message, nativeChatStoppedBeforeStartLabel())
    : null
}
