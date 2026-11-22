import type { NativeChatBlock, NativeChatMessage } from '../../native-chat-types'

/** Journal-less transcripts mark where the agent resumed on its own, such as a background task's hand-back. */
export const NATIVE_CHAT_PROVIDER_TURN_START_PRESENTATION = 'provider-turn-start'

export function isNativeChatProviderTurnStartBlock(block: NativeChatBlock): boolean {
  return (
    block.type === 'text' && block.presentation === NATIVE_CHAT_PROVIDER_TURN_START_PRESENTATION
  )
}

/** Opens a turn and draws nothing but that turn's bar. */
export function isNativeChatProviderTurnStart(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): boolean {
  return message.role === 'system' && message.blocks.some(isNativeChatProviderTurnStartBlock)
}
