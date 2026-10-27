import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import { withoutNativeChatVisualDirectiveLines } from '../../../../shared/native-chat/native-chat-visual-directive'
import { nativeChatBlocksInOwnWords } from './native-chat-stopped-before-start-row'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

/** What a message row's hover copy button copies: its words, less any agent visual lines. */
export function nativeChatMessageCopyText(message: NativeChatMessage): string {
  const { markdown } = deriveNativeChatRowContent(nativeChatBlocksInOwnWords(message.blocks))
  return message.role === 'user' ? markdown : withoutNativeChatVisualDirectiveLines(markdown)
}

/** The copy text of the transcript row drawing `messageId`, or null when no row draws it. */
export function nativeChatSlotCopyText(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string
): string | null {
  const slot = slots.find((entry) => entry.kind === 'message' && entry.message.id === messageId)
  return slot?.kind === 'message' ? nativeChatMessageCopyText(slot.message) : null
}
