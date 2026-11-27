import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { projectionBesideStreamedText } from '../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import { nativeChatTaskListPredecessors } from '../../../../../shared/native-chat/input/task-lists/native-chat-task-list-history'

/** Each message's earlier task lists. Task calls are never reply text, so a streaming reply keeps
 *  this across its text-only revisions. */
export function useNativeChatTaskListPredecessors(messages: readonly NativeChatMessage[]) {
  const structure = projectionBesideStreamedText(messages)
  return useMemo(() => nativeChatTaskListPredecessors(structure), [structure])
}
