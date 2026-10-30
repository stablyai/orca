import { useMemo } from 'react'
import { mergeNativeChatLiveSession } from '../../../../shared/native-chat/native-chat-live-status'
import { messageCancelAction } from './native-chat-session-transport'
import type { getNativeChatSessionTransport } from './native-chat-session-transport'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-contract'
import type { useNativeChatCurrentQuestions } from './use-native-chat-current-questions'
import type { useNativeChatHookStatus } from './use-native-chat-hook-status'
import type { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'

type SessionViewArgs = {
  normalizedMessages: NativeChatMessage[]
  assembledMessages: NativeChatMessage[]
  currentQuestionView: ReturnType<typeof useNativeChatCurrentQuestions>[1]
  transport: ReturnType<typeof getNativeChatSessionTransport>
  transcriptPath: UseNativeChatLiveSessionArgs['transcriptPath']
  read: ReadState
  sessionId: UseNativeChatLiveSessionArgs['sessionId']
  agent: UseNativeChatLiveSessionArgs['agent']
  hookState: ReturnType<typeof useNativeChatHookStatus>[0]
  hookStateStartedAt: ReturnType<typeof useNativeChatHookStatus>[1]
  transcriptLifecycle: ReturnType<typeof useNativeChatTranscriptLifecycle>[0]
  hookHasWorkingSubagents: ReturnType<typeof useNativeChatHookStatus>[2]
  hasMore: boolean
  loadingEarlier: boolean
  olderHistoryGeneration: number
  loadEarlier: NativeChatLiveSession['loadEarlier']
  appended: NativeChatMessage[]
}

export function useNativeChatLiveSessionView(args: SessionViewArgs): NativeChatLiveSession {
  const {
    normalizedMessages,
    assembledMessages,
    currentQuestionView,
    transport,
    transcriptPath,
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
    appended
  } = args
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
      // Live content outranks stale errors/spinners; apply overrides only before any append (#8401).
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return {
      ...session,
      ...currentQuestionView,
      cancelMessageQuestions: messageCancelAction(transport, agent, sessionId, transcriptPath),
      hasMore,
      loadingEarlier,
      olderHistoryGeneration,
      loadEarlier,
      readPhase: read.phase
    }
  }, [
    normalizedMessages,
    assembledMessages,
    currentQuestionView,
    transport,
    transcriptPath,
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
    appended
  ])
}
