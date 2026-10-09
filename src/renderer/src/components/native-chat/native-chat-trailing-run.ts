// Which of an agent's rows is its live frontier: the last one where it spoke or acted.
// A tool run stays live until a later row of the same agent moves past it.

import { isToolCallBlock, type NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'

/** Whether a row moves its agent past the run above it. An approval's receipt
 *  decides a call of that run, which then runs, so it does not. */
export function nativeChatRowSpeaksOrActs(
  message: NativeChatMessage,
  rendersProse: boolean,
  receipts: ReadonlyMap<string, NativeChatResolvedPrompt>
): boolean {
  return (
    message.role !== 'user' &&
    message.role !== 'reasoning' &&
    receipts.get(message.id)?.kind !== 'approval' &&
    (rendersProse || message.blocks.some(isToolCallBlock))
  )
}

export function nativeChatRowRendersProse(message: NativeChatMessage): boolean {
  const content = deriveNativeChatRowContent(message.blocks)
  return content.markdown.length > 0 || content.hasImages
}
