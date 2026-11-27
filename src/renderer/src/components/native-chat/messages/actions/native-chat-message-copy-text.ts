import { translate } from '@/i18n/i18n'
import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/view/messages/agent-message-display-text'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatMessageCopyText } from '../../../../../../shared/native-chat/transcript/messages/native-chat-message-copy-text'
import {
  agentMessageHeading,
  agentMessageSavedName
} from '../../../../../../shared/agent-session/view/messages/agent-message-presentation'
import { agentMessageRowLead, agentMessageRowFallback } from '../rows/agent-message-row-lead'
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
  if (!message.from || !(message.role === 'user' || message.agentStart)) {
    return nativeChatMessageCopyText(message, nativeChatStoppedBeforeStartLabel())
  }
  const text = agentMessageTranscriptText(message.blocks, message.from, message.shortened)
  const items = message.agentStartItems ?? []
  if (items.length === 0) {
    return text
  }
  // A start joined to its item link copies what its row says: "Started <worker> for <item>".
  const heading = agentMessageHeading(message.from, message)
  const worker = agentMessageSavedName(message.from.senders[0]) ?? agentMessageRowFallback(heading)
  const row = [
    agentMessageRowLead(heading),
    worker,
    translate('components.native-chat.agentMessage.row.forItems', 'for'),
    items.map((item) => item.title).join(', ')
  ].join(' ')
  return text ? `${row}\n\n${text}` : row
}
