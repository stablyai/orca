import type { NativeChatTaskList } from './native-chat-task-list'
import type { NativeChatMessage } from '../native-chat-types'
import { latestNativeChatTaskList } from './native-chat-task-seed'
import type { NativeChatTaskSeedList } from './native-chat-claude-task-updates'

/** The plan docked above the composer: the list as of the last accepted update, gone once emptied. */
export function nativeChatDockedTaskList(
  messages: readonly NativeChatMessage[],
  seed?: NativeChatTaskSeedList | null
): NativeChatTaskList | null {
  const list = latestNativeChatTaskList(messages, seed)
  return list && list.tasks.length > 0 ? list : null
}
