import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatBlocksInOwnWords } from '../pending-sends/native-chat-stopped-before-start'
import { withoutSentImagePromptMarkers } from '../images/native-chat-sent-image-prompt-markers'

export function nativeChatMessageDisplayBlocks(message: NativeChatMessage, stoppedLabel: string) {
  return nativeChatBlocksInOwnWords(withoutSentImagePromptMarkers(message), stoppedLabel)
}
