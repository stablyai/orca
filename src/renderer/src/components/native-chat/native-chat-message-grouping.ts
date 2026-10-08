// Stable message ordering for the native chat message list: timestamp then id,
// null timestamps first as the shared model documents.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { compareMessages } from './native-chat-session-assembler'

/** Order messages stably: null timestamps first (model rule), then ascending
 *  timestamp, ties broken by id. Shares the assembler's comparator so both
 *  paths order identically. */
export function orderNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  return [...messages].sort(compareMessages)
}
