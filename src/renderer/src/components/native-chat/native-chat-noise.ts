import { isTextBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'
import { isHarnessInjectedUserTurnText } from '../../../../shared/harness-injected-user-turns'

// Why: harness machinery turns land in the transcript but are not real user
// messages, so the chat filters them out (they were confusingly rendered as
// the user's own bubbles). The prefix list lives in
// src/shared/harness-injected-user-turns.ts, shared with the agent-status
// prompt pipeline. Mirrors the mobile predicate in
// mobile/src/session/mobile-native-chat-noise.ts.

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
  return isHarnessInjectedUserTurnText(messageText(message))
}

/** Drop harness-noise messages from a transcript. */
export function stripNoiseMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return messages.filter((m) => !isNoiseMessage(m))
}
