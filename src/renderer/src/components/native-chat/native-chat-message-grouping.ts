import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { compareMessages } from './native-chat-session-assembler'

/** Reuse assembler ordering: null timestamps first, then timestamp and id. */
export function orderNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  return [...messages].sort(compareMessages)
}
