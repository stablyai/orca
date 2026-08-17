import { isTextBlock, isToolCallBlock, type NativeChatMessage } from './native-chat-types'

export function findNativeChatFinalMessageIndex(
  messages: readonly NativeChatMessage[],
  allowUnclassified: boolean
): number {
  const boundary = messages.findLastIndex((message) => message.role === 'user')
  const explicit = findAnswer(messages, boundary, (message) => message.assistantPhase === 'final')
  return explicit !== -1 || !allowUnclassified
    ? explicit
    : findAnswer(messages, boundary, (message) => message.assistantPhase === undefined)
}

function findAnswer(
  messages: readonly NativeChatMessage[],
  boundary: number,
  phaseMatches: (message: NativeChatMessage) => boolean
): number {
  for (let index = messages.length - 1; index > boundary; index -= 1) {
    const message = messages[index]!
    if (
      message.role === 'assistant' &&
      phaseMatches(message) &&
      message.blocks.some((block) => isTextBlock(block) || block.type === 'image-ref') &&
      !message.blocks.some(isToolCallBlock)
    ) {
      return index
    }
  }
  return -1
}
