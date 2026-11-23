import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/view/messages/agent-message-display-text'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatMessageCopyText } from '../../../../../../shared/native-chat/transcript/messages/native-chat-message-copy-text'
import { nativeChatStoppedBeforeStartLabel } from '../rows/native-chat-stopped-before-start-row'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'

/** The copy text of the transcript row drawing `messageId`, or null when no row draws it. */
export function nativeChatSlotCopyText(
  slots: readonly NativeChatTranscriptSlot[],
  messageId: string
): string | null {
  const slot = slots.find((entry) => entry.kind === 'message' && entry.message.id === messageId)
  return slot?.kind === 'message' ? nativeChatRowCopyText(slot.message) : null
}

/** What "Copy message" copies for a row drawing `message`. */
export function nativeChatRowCopyText(message: NativeChatMessage): string {
  return message.from && (message.role === 'user' || message.agentStart)
    ? agentMessageTranscriptText(message.blocks, message.from, message.shortened)
    : nativeChatMessageCopyText(message, nativeChatStoppedBeforeStartLabel())
}
