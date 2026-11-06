import { useMemo } from 'react'
import {
  nativeChatTaskListPredecessors,
  type NativeChatTaskListPredecessors
} from '../../../../shared/native-chat/input/native-chat-task-list-history'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'

/** Ids already painted, plus the task-list call that preceded each row. */
export function useNativeChatTranscriptIndexes(
  messages: readonly NativeChatMessage[],
  sections: NativeChatSubagentSections
): {
  loadedMessageIds: Set<string>
  taskListPredecessors: Map<string, NativeChatTaskListPredecessors>
} {
  const loadedMessageIds = useMemo(
    () => new Set([...messages.map(({ id }) => id), ...sections.pathOf.keys()]),
    [messages, sections]
  )
  const taskListPredecessors = useMemo(() => nativeChatTaskListPredecessors(messages), [messages])
  return { loadedMessageIds, taskListPredecessors }
}
