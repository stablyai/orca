import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatTaskList } from './NativeChatTaskList'
import { nativeChatTaskListState } from './native-chat-task-list-state'

/** The conversation's current task list, docked under the transcript. */
export function NativeChatDockedTaskList({
  messages
}: {
  messages: readonly NativeChatMessage[]
}): React.JSX.Element | null {
  const { list } = useMemo(() => nativeChatTaskListState(messages), [messages])
  if (!list || list.tasks.length === 0) {
    return null
  }
  return (
    <div className="shrink-0 px-3 pb-2 sm:px-4">
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <NativeChatTaskList list={list} presentation="composer" />
      </div>
    </div>
  )
}
