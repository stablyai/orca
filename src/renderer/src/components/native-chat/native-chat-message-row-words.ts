import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../shared/native-chat/transcript/native-chat-row-content'
import { nativeChatBlocksInOwnWords } from '../../../../shared/native-chat/native-chat-stopped-before-start'
import { nativeChatStoppedBeforeStartLabel } from './native-chat-stopped-before-start-row'

/** A row's blocks as it draws them, with Orca's stopped-send line in the reader's words. */
export function nativeChatMessageRowBlocks(message: NativeChatMessage): NativeChatBlock[] {
  return nativeChatBlocksInOwnWords(message.blocks, nativeChatStoppedBeforeStartLabel())
}

/** The words an agent row draws and copies; Copy exists only where these do. */
export function nativeChatAgentRowWords(message: NativeChatMessage): string {
  // A thought heading a run reads inside it, so the row has no words of its own.
  return message.role === 'reasoning'
    ? ''
    : deriveNativeChatRowContent(nativeChatMessageRowBlocks(message)).markdown
}

/** Whether an agent row draws images: a response with no words can still hold its turn's actions. */
export function nativeChatAgentRowHasImages(message: NativeChatMessage): boolean {
  return (
    message.role !== 'reasoning' &&
    deriveNativeChatRowContent(nativeChatMessageRowBlocks(message)).hasImages
  )
}
