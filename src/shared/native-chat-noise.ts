import { isKnownHarnessInjectedUserTurnText } from './harness-injected-user-turns'
import { isTextBlock, type NativeChatMessage } from './native-chat-types'

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Harness-injected user/system turns are transport machinery, not conversation. */
export function isNoiseMessage(message: NativeChatMessage): boolean {
  if (message.role !== 'user' && message.role !== 'system') {
    return false
  }
  if (message.blocks.some((block) => block.type === 'tool-call' || block.type === 'tool-result')) {
    return false
  }
  return isKnownHarnessInjectedUserTurnText(messageText(message))
}

export function stripNoiseMessages(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return messages.filter((message) => !isNoiseMessage(message))
}
