import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatDockedTaskList } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-state'
import { NativeChatTaskList } from './NativeChatTaskList'

export function NativeChatDockedTaskList({
  messages
}: {
  messages: readonly NativeChatMessage[]
}): React.JSX.Element | null {
  const list = useMemo(() => nativeChatDockedTaskList(messages), [messages])
  if (!list) {
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
