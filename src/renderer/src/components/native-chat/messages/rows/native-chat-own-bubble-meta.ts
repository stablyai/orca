// Whether a row ends in the person's own bubble and its hover-only copy/time row, which keeps its
// height while invisible. Mirrors MessageRow's branches before NativeChatUserMessageRow: keep in step.
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatBotMessageCardOf } from '../../../../../../shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { nativeChatMessageRowBlocks } from './native-chat-message-row-words'

export function nativeChatRowEndsInOwnBubbleMeta(message: NativeChatMessage): boolean {
  // Another agent's mail draws a card; runs, waits, notes, notices and bot cards draw their own rows.
  if (
    message.role !== 'user' ||
    message.from ||
    message.automationSaved ||
    message.automationRunNotStarted ||
    message.automationRun ||
    message.waitEnded ||
    message.botItemNote ||
    nativeChatBotMessageCardOf(message)
  ) {
    return false
  }
  // Of the Orca notices, only a takeover with a goal goes on to draw the bubble.
  if (message.orcaNotice && !(message.orcaNotice === 'took-over' && message.tookOver?.goal)) {
    return false
  }
  const blocks = nativeChatMessageRowBlocks(message)
  if (blocks.some((block) => block.type === 'text' && block.providerFrame)) {
    return false
  }
  // The hover row shows a time or a copy button; an image-only prompt with no time has neither.
  return message.timestamp !== null || deriveNativeChatRowContent(blocks).markdown.length > 0
}
