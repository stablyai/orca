import { latestNativeChatTaskList } from '../../../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskList } from '../../../../shared/native-chat/input/native-chat-task-list'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

/** Select composer progress without consuming historical transcript updates. */
export function nativeChatTaskListState(messages: readonly NativeChatMessage[]): {
  messages: readonly NativeChatMessage[]
  list: NativeChatTaskList | null
} {
  return { messages, list: latestNativeChatTaskList(messages) }
}
