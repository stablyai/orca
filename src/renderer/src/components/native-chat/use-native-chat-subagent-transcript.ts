import { useCallback, useMemo, useState } from 'react'
import { nativeChatSubagentActivities } from '../../../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskSeedList } from '../../../../shared/native-chat/input/native-chat-claude-task-updates'
import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/native-chat-terminal-turn'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'

const NO_SUBAGENT_ROWS: ReadonlyMap<string, readonly NativeChatSubagentRow[]> = new Map()

/** Which transcript the chat is showing, and the parent turn chrome to hide while a child is open. */
export function useNativeChatSubagentTranscript({
  session,
  messages,
  subagentRows,
  subagentRoster,
  isWorking,
  awaitingInput,
  stopping,
  activityText,
  lifecycleWorking
}: {
  session: { sessionId: string | null; taskList?: NativeChatTaskSeedList | null }
  messages: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  subagentRoster: StructuredAgentSubagentRoster | undefined
  isWorking: boolean
  awaitingInput: NativeChatAwaitingInput | null
  stopping: boolean
  activityText: string | undefined
  lifecycleWorking: boolean
}): {
  transcriptMessages: readonly NativeChatMessage[]
  sectionRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  sectionRoster: StructuredAgentSubagentRoster | undefined
  shownWorking: boolean
  shownAwaitingInput: NativeChatAwaitingInput | null
  shownStopping: boolean
  shownActivityText: string | undefined
  shownLifecycleWorking: boolean
  activity: {
    messages: readonly NativeChatMessage[]
    subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
    focusedSubagentId: string | null
    onFocusSubagent: (agentId: string | null) => void
    taskList: NativeChatTaskSeedList | null
  }
} {
  const { sessionId, taskList = null } = session
  const [focus, setFocus] = useState<{ sessionId: string | null; agentId: string | null }>({
    sessionId,
    agentId: null
  })
  if (focus.sessionId !== sessionId) {
    setFocus({ sessionId, agentId: null })
  }
  const requestedId = focus.sessionId === sessionId ? focus.agentId : null
  const activities = useMemo(
    () => nativeChatSubagentActivities(messages, subagentRows),
    [messages, subagentRows]
  )
  // A roster entry can be focused before its rows load. Drop it only once it leaves the roster.
  const viewingSubagent =
    requestedId != null && activities.some((agent) => agent.id === requestedId)
  if (requestedId && !viewingSubagent) {
    setFocus({ sessionId, agentId: null })
  }
  const transcriptMessages = useMemo(() => {
    if (!viewingSubagent || !requestedId) {
      return messages
    }
    return subagentRows.get(requestedId)?.map((row) => row.message) ?? []
  }, [messages, requestedId, subagentRows, viewingSubagent])
  const onFocusSubagent = useCallback(
    (agentId: string | null) => setFocus({ sessionId, agentId }),
    [sessionId]
  )
  const focusedSubagentId = viewingSubagent ? requestedId : null
  return {
    transcriptMessages,
    sectionRows: viewingSubagent ? NO_SUBAGENT_ROWS : subagentRows,
    sectionRoster: viewingSubagent ? undefined : subagentRoster,
    shownWorking: viewingSubagent ? false : isWorking,
    shownAwaitingInput: viewingSubagent ? null : awaitingInput,
    shownStopping: viewingSubagent ? false : stopping,
    shownActivityText: viewingSubagent ? undefined : activityText,
    shownLifecycleWorking: viewingSubagent ? false : lifecycleWorking,
    activity: { messages, subagentRows, focusedSubagentId, onFocusSubagent, taskList }
  }
}
