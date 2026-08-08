import { useMemo } from 'react'
import type {
  NativeChatMessage,
  NativeChatSession,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import {
  type NativeChatReadState,
  type UseNativeChatSessionStreamArgs,
  useNativeChatSessionStream
} from './use-native-chat-session-stream'

export type UseNativeChatLiveSessionArgs = UseNativeChatSessionStreamArgs
export {
  isNativeChatTranscriptUnsettled,
  NOTFOUND_RETRY_WINDOW_MS
} from './use-native-chat-session-stream'

export type NativeChatLiveSession = NativeChatSession & {
  transcriptLifecycle?: NativeChatTurnLifecycle
  context: AgentSessionContextSnapshot
  markCompactionRequested: () => void
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
  readPhase: NativeChatReadState['phase']
}

const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

/** Streams a transcript and merges it with live hook state for one pane. */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId } = args
  const {
    read,
    context,
    hasMore,
    loadingEarlier,
    loadEarlier,
    markCompactionRequested,
    appended,
    transcriptLifecycle
  } = useNativeChatSessionStream(args)
  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)
  const baseMessages = read.phase === 'ready' ? read.messages : EMPTY_MESSAGES
  const { assembledMessages, normalizedMessages } = useNativeChatAssembledMessages({
    agent,
    sessionId,
    baseMessages,
    appended
  })

  return useMemo<NativeChatLiveSession>(() => {
    const session = mergeNativeChatLiveSession({
      messages: normalizedMessages,
      sessionId,
      agent,
      hookState,
      stateStartedAt: hookStateStartedAt,
      transcriptLifecycle,
      statusTailMessage: assembledMessages.at(-1),
      hookHasWorkingSubagents,
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return {
      ...session,
      transcriptLifecycle,
      context,
      markCompactionRequested,
      hasMore,
      loadingEarlier,
      loadEarlier,
      readPhase: read.phase
    }
  }, [
    normalizedMessages,
    assembledMessages,
    read,
    sessionId,
    agent,
    hookState,
    hookStateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents,
    hasMore,
    loadingEarlier,
    loadEarlier,
    appended,
    context,
    markCompactionRequested
  ])
}
