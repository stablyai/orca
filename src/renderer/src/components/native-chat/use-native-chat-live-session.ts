import { useMemo } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
export type { NativeChatLiveSession, ReadState } from './native-chat-live-session-contract'
import { mergeNativeChatLiveSession, nativeChatHookAwaitsInput } from './native-chat-live-status'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import {
  type UseNativeChatSessionStreamArgs,
  useNativeChatSessionStream
} from './use-native-chat-session-stream'

export type UseNativeChatLiveSessionArgs = UseNativeChatSessionStreamArgs
export {
  isNativeChatTranscriptUnsettled,
  NOTFOUND_RETRY_WINDOW_MS
} from './use-native-chat-session-stream'

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
    olderHistoryGeneration,
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
      hookAwaitingInput: nativeChatHookAwaitsInput(
        hookState,
        hookStateStartedAt,
        transcriptLifecycle
      ),
      transcriptLifecycle,
      context,
      markCompactionRequested,
      hasMore,
      loadingEarlier,
      olderHistoryGeneration,
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
    olderHistoryGeneration,
    loadEarlier,
    appended,
    context,
    markCompactionRequested
  ])
}
