import { useMemo } from 'react'
import { projectionBesideStreamedText } from '../../../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatDockedTaskList } from '../../../../../../shared/native-chat/input/task-lists/native-chat-task-list-state'
import { NativeChatTaskList } from './NativeChatTaskList'

export function NativeChatDockedTaskList({
  messages
}: {
  messages: readonly NativeChatMessage[]
}): React.JSX.Element | null {
  // Task lists come from tool calls, never reply text, so the list holds while a reply streams.
  const structure = projectionBesideStreamedText(messages)
  const list = useMemo(() => nativeChatDockedTaskList(structure), [structure])
  if (!list) {
    return null
  }
  return (
    // Under the worker chip, which sits on the transcript's end, the list keeps the dock's 8px gap.
    <div className="shrink-0 px-3 pb-2 sm:px-4 [:is([data-native-chat-worker-dock],[data-native-chat-worker-chip-slot]):has([data-native-chat-background-tasks])+&]:pt-2">
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <NativeChatTaskList list={list} presentation="composer" />
      </div>
    </div>
  )
}
