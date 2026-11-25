import { isKnownHarnessInjectedUserTurnText } from '../../../agent-session/journal/harness-injected-user-turns'
import { isTextBlock, type NativeChatMessage } from '../../native-chat-types'
import { isNativeChatOrcaCard } from '../../native-chat-orca-card'
import { isNativeChatProviderTurnStart } from '../turns/native-chat-provider-turn-start'

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Harness-injected user/system turns are transport machinery, not conversation. */
export function isNoiseMessage(message: NativeChatMessage): boolean {
  if (isNativeChatOrcaCard(message) || isNativeChatProviderTurnStart(message)) {
    return false
  }
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
