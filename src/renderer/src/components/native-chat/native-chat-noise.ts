import { isTextBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'
import { isKnownHarnessInjectedUserTurnText } from '../../../../shared/harness-injected-user-turns'

// Why: harness machinery turns land in the transcript but are not real user
// messages, so the chat filters them out (they were confusingly rendered as
// the user's own bubbles). The classifier lives in
// src/shared/harness-injected-user-turns.ts, shared with the agent-status
// prompt pipeline; structurally marked turns (isMeta etc.) are already
// dropped by the Claude transcript decoder.

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('')
    .trim()
}

/** True when a message is harness machinery rather than real conversation. Only
 *  user/system turns qualify — assistant/tool turns and any turn carrying real
 *  tool activity are always kept. */
export function isNoiseMessage(message: NativeChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'system') {
    return false
  }
  // Keep turns that carry tool activity (e.g. a user turn with tool results).
  if (message.blocks.some((b) => b.type === 'tool-call' || b.type === 'tool-result')) {
    return false
  }
  return isKnownHarnessInjectedUserTurnText(messageText(message))
}

/** Drop harness-noise messages from a transcript. */
export function stripNoiseMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return messages.filter((m) => !isNoiseMessage(m))
}
