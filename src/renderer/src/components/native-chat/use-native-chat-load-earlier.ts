import { useCallback, type MutableRefObject } from 'react'
import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import { hasMoreNativeChatHistory, nextNativeChatLimit } from './native-chat-pagination'
import type { ReadState } from './native-chat-live-session-types'

type TranscriptLifecycleControl = {
  revision: () => number
  replaceFromPagination: (lifecycle: NativeChatTurnLifecycle | undefined, revision: number) => void
}

type SessionTransport = {
  readSession: (
    agent: string,
    sessionId: string,
    limit: number,
    transcriptPath?: string
  ) => Promise<
    | { messages: NativeChatMessage[]; lifecycle?: NativeChatTurnLifecycle }
    | { error: string }
    | null
    | undefined
  >
}

export function useNativeChatLoadEarlier(args: {
  agent: string
  sessionId: string | null
  transcriptPath?: string | null
  transport: SessionTransport
  hasMore: boolean
  loadingEarlier: boolean
  readPhase: ReadState['phase']
  transcriptLifecycleControl: TranscriptLifecycleControl
  limitRef: MutableRefObject<number>
  transcriptEpochRef: MutableRefObject<number>
  latestEnabled: MutableRefObject<boolean>
  latestSessionId: MutableRefObject<string | null>
  latestTransport: MutableRefObject<SessionTransport>
  setLoadingEarlier: (value: boolean) => void
  setRead: (value: ReadState) => void
  setHasMore: (value: boolean) => void
}): () => void {
  const {
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    loadingEarlier,
    readPhase,
    transcriptLifecycleControl,
    limitRef,
    transcriptEpochRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    setLoadingEarlier,
    setRead,
    setHasMore
  } = args

  return useCallback(() => {
    if (
      !latestEnabled.current ||
      !sessionId ||
      loadingEarlier ||
      !hasMore ||
      readPhase !== 'ready'
    ) {
      return
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    const requestEpoch = transcriptEpochRef.current
    const lifecycleRevision = transcriptLifecycleControl.revision()
    setLoadingEarlier(true)
    void transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined)
      .then((result) => {
        // Ignore a stale resolve from a swapped session or flipped owner.
        if (
          !latestEnabled.current ||
          latestSessionId.current !== sessionId ||
          latestTransport.current !== transport ||
          transcriptEpochRef.current !== requestEpoch
        ) {
          return
        }
        if (!result || 'error' in result) {
          return
        }
        limitRef.current = nextLimit
        setRead({ phase: 'ready', messages: result.messages })
        transcriptLifecycleControl.replaceFromPagination(result.lifecycle, lifecycleRevision)
        setHasMore(hasMoreNativeChatHistory(result.messages.length, nextLimit))
      })
      .catch(() => {
        // Keep the already-loaded transcript intact rather than surface rejection.
      })
      .finally(() => {
        if (latestEnabled.current && transcriptEpochRef.current === requestEpoch) {
          setLoadingEarlier(false)
        }
      })
  }, [
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    loadingEarlier,
    readPhase,
    transcriptLifecycleControl,
    limitRef,
    transcriptEpochRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    setLoadingEarlier,
    setRead,
    setHasMore
  ])
}
