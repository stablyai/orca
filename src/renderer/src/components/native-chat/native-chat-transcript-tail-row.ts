import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/native-chat-terminal-turn'

export function transcriptTailRow(
  isWorking: boolean,
  awaitingInput: NativeChatAwaitingInput | null
): 'awaiting-input' | 'activity' | null {
  if (awaitingInput === 'unshown') {
    return 'awaiting-input'
  }
  return isWorking && awaitingInput === null ? 'activity' : null
}
