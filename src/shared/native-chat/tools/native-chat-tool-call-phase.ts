import type { NativeChatToolCallBlock, NativeChatToolResultBlock } from '../native-chat-types'

export function nativeChatToolCallPhase(
  call: NativeChatToolCallBlock,
  result?: NativeChatToolResultBlock
) {
  return {
    running: call.state === 'running',
    completed:
      call.state !== 'failed' &&
      !result?.isError &&
      (call.state === 'completed' || result !== undefined),
    failed: call.state === 'failed' || result?.isError === true
  }
}
