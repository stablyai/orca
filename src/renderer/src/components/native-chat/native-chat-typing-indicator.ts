import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'
import { isCommandMarkerId } from './native-chat-command-marker'

function isToolActivityOnlyRow(message: NativeChatMessage): boolean {
  const blocks = message.blocks
  if (!blocks || blocks.length === 0) {
    return false
  }
  return blocks.every((block) => block.type === 'tool-call' || block.type === 'tool-result')
}

export function shouldShowNativeChatTypingIndicator(args: {
  messages: readonly NativeChatMessage[]
  isWorking: boolean
}): boolean {
  if (!args.isWorking) {
    return false
  }
  const { messages } = args
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role === 'user' || isCommandMarkerId(message.id)) {
      return true
    }
    if (isToolActivityOnlyRow(message)) {
      return true
    }
    if (message.role === 'assistant' || message.id === NATIVE_CHAT_STREAMING_ID) {
      return false
    }
  }
  return true
}
