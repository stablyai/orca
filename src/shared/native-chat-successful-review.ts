import type { NativeChatMessage, NativeChatTextBlock } from './native-chat/native-chat-types'

function isSuccessfulReview(block: NativeChatTextBlock): boolean {
  const frame = block.providerFrame
  return (
    block.presentation === undefined &&
    block.failure === undefined &&
    block.orcaStop === undefined &&
    block.usageLimitTurnItemId === undefined &&
    block.tone === 'warning' &&
    frame?.provider === 'codex' &&
    (frame.kind === 'notification:warning' || frame.kind === 'notification:guardianWarning') &&
    /^Automatic approval review approved \([^\n)]+\):\s+\S/.test(block.text)
  )
}

export function isNativeChatSuccessfulReviewMessage(message: NativeChatMessage): boolean {
  return (
    message.role === 'system' &&
    message.blocks.length > 0 &&
    message.blocks.every((block) => block.type === 'text' && isSuccessfulReview(block))
  )
}
