import type { NativeChatAwaitingInput } from './NativeChatMessageList'

export function transcriptTailRow(
  isWorking: boolean,
  awaitingInput: NativeChatAwaitingInput | null
): 'awaiting-input' | 'activity' | null {
  if (awaitingInput === 'unshown') {
    return 'awaiting-input'
  }
  return isWorking && awaitingInput === null ? 'activity' : null
}
