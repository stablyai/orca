import { useCallback, useMemo, useState } from 'react'
import {
  nativeChatSubagentActivities,
  type NativeChatSubagentActivity
} from '../../../../shared/native-chat/input/native-chat-activity'
import type { NativeChatAwaitingInput } from '../../../../shared/native-chat/native-chat-terminal-turn'
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { frameNativeChatSubagentTranscript } from '../../../../shared/native-chat/input/native-chat-subagent-brief'
import { linkUnrecordedSubagentSpawns } from '../../../../shared/native-chat/input/native-chat-unlinked-subagent-spawn'
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
  activityText
}: {
  session: {
    sessionId: string | null
    hasMore: boolean
    readPhase: string
    loadingEarlier: boolean
    loadEarlier: () => Promise<NativeChatOlderPageResult>
    transcriptLifecycle?: { state?: string }
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
    subagentSeed: readonly NativeChatSubagentActivity[] | null
    sessionId: string | null
  }
  history: {
    hasMore: boolean
    loadingEarlier: boolean
    loadEarlier: () => Promise<NativeChatOlderPageResult>
  }
} {
  const { sessionId, subagentSeed = null, readSubagentPage = null } = session
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
    const childPage = readSubagentPage
      ? (page.messages ?? [])
      : (subagentRows.get(requestedId)?.map((row) => row.message) ?? [])
    const focusedAgent = activities.find((agent) => agent.id === requestedId)
    return frameNativeChatSubagentTranscript(
      requestedId,
      childPage,
      linkUnrecordedSubagentSpawns(messages),
      focusedAgent ? { title: focusedAgent.label, prompt: null } : undefined,
      !readSubagentPage || page.messages != null
    )
  }, [
    activities,
    messages,
    page.messages,
    readSubagentPage,
    requestedId,
    subagentRows,
    viewingSubagent
  ])
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
    shownLifecycleWorking: !viewingSubagent && session.transcriptLifecycle?.state === 'working',
    history:
      readSubagentPage && focusedSubagentId
        ? {
            hasMore: page.hasMore && !page.loading,
            loadingEarlier: page.loadingEarlier,
            loadEarlier: page.loadEarlier
          }
        : {
            // Pending/failed reads cannot page; recovery remounts the sentinel to recheck its range.
            hasMore: session.hasMore && session.readPhase === 'ready',
            loadingEarlier: session.loadingEarlier,
            loadEarlier: session.loadEarlier
          },
    activity: {
      messages,
      subagentRows: activityRows,
      focusedSubagentId,
      focusedTranscriptLoading: Boolean(readSubagentPage && focusedSubagentId && page.loading),
      onFocusSubagent,
      subagentSeed,
      sessionId
    }
  }
}
