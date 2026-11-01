import { useCallback, useMemo, useState } from 'react'
import {
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../../../shared/native-chat/input/native-chat-activity'
import type { NativeChatTaskSeedList } from '../../../../shared/native-chat/input/native-chat-claude-task-updates'
import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/native-chat-terminal-turn'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import {
  useNativeChatSubagentPage,
  type NativeChatSubagentPageRead
} from './use-native-chat-subagent-page'

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
  session: {
    sessionId: string | null
    taskList?: NativeChatTaskSeedList | null
    subagentSeed?: readonly NativeChatSubagentActivity[] | null
    readSubagentPage?: NativeChatSubagentPageRead | null
  }
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
    focusedTranscriptLoading: boolean
    onFocusSubagent: (agentId: string | null) => void
    taskList: NativeChatTaskSeedList | null
    subagentSeed: readonly NativeChatSubagentActivity[] | null
  }
  childHistory: {
    hasMore: boolean
    loadingEarlier: boolean
    loadEarlier: () => Promise<NativeChatOlderPageResult>
  } | null
} {
  const { sessionId, taskList = null, subagentSeed = null, readSubagentPage = null } = session
  const [focus, setFocus] = useState<{ sessionId: string | null; agentId: string | null }>({
    sessionId,
    agentId: null
  })
  if (focus.sessionId !== sessionId) {
    setFocus({ sessionId, agentId: null })
  }
  const requestedId = focus.sessionId === sessionId ? focus.agentId : null
  const activities = useMemo(
    () => nativeChatSubagentActivities(messages, subagentRows, subagentSeed),
    [messages, subagentRows, subagentSeed]
  )
  // A roster entry can be focused before its rows load. Drop it only once it leaves the roster.
  const viewingSubagent =
    requestedId != null && activities.some((agent) => agent.id === requestedId)
  if (requestedId && !viewingSubagent) {
    setFocus({ sessionId, agentId: null })
  }
  const focusedSubagentId = viewingSubagent ? requestedId : null
  const page = useNativeChatSubagentPage(
    readSubagentPage ? focusedSubagentId : null,
    readSubagentPage
  )
  const transcriptMessages = useMemo(() => {
    if (!viewingSubagent || !requestedId) {
      return messages
    }
    if (readSubagentPage) {
      return page.messages ?? []
    }
    return subagentRows.get(requestedId)?.map((row) => row.message) ?? []
  }, [messages, page.messages, readSubagentPage, requestedId, subagentRows, viewingSubagent])
  const activityRows = useMemo(() => {
    if (!focusedSubagentId || !page.messages) {
      return subagentRows
    }
    const next = new Map(subagentRows)
    next.set(
      focusedSubagentId,
      page.messages.map((message) => ({ message, turnKey: undefined }))
    )
    return next
  }, [focusedSubagentId, page.messages, subagentRows])
  const onFocusSubagent = useCallback(
    (agentId: string | null) => setFocus({ sessionId, agentId }),
    [sessionId]
  )
  return {
    transcriptMessages,
    sectionRows: viewingSubagent ? NO_SUBAGENT_ROWS : subagentRows,
    sectionRoster: viewingSubagent ? undefined : subagentRoster,
    shownWorking: viewingSubagent ? false : isWorking,
    shownAwaitingInput: viewingSubagent ? null : awaitingInput,
    shownStopping: viewingSubagent ? false : stopping,
    shownActivityText: viewingSubagent ? undefined : activityText,
    shownLifecycleWorking: viewingSubagent ? false : lifecycleWorking,
    childHistory:
      readSubagentPage && focusedSubagentId
        ? {
            hasMore: page.hasMore && !page.loading,
            loadingEarlier: page.loadingEarlier,
            loadEarlier: page.loadEarlier
          }
        : null,
    activity: {
      messages,
      subagentRows: activityRows,
      focusedSubagentId,
      focusedTranscriptLoading: Boolean(readSubagentPage && focusedSubagentId && page.loading),
      onFocusSubagent,
      taskList,
      subagentSeed
    }
  }
}
