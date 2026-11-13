import { useCallback, useRef, type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { ReadState } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatSessionTransport } from '../../session/terminal/read/native-chat-session-transport'
import type { useNativeChatTranscriptLifecycle } from '../../session/terminal/read/use-native-chat-transcript-lifecycle'
import {
  hasMoreNativeChatHistory,
  nextNativeChatLimit,
  type NativeChatOlderPageResult
} from './native-chat-pagination'

const USER_PAGING = { wakeWslDistro: true } as const

export function useNativeChatOlderHistory({
  agent,
  sourceKey,
  sessionId,
  transcriptPath,
  transport,
  hasMore,
  read,
  transcriptLifecycleControl,
  limitRef,
  latestEnabled,
  latestSessionId,
  latestTransport,
  transcriptEpochRef,
  setLoadingEarlier,
  setRead,
  setHasMore
}: {
  agent: AgentType
  sourceKey: string
  sessionId: string | null
  transcriptPath?: string | null
  transport: NativeChatSessionTransport
  hasMore: boolean
  read: ReadState
  transcriptLifecycleControl: ReturnType<typeof useNativeChatTranscriptLifecycle>[1]
  limitRef: RefObject<number>
  latestEnabled: RefObject<boolean>
  latestSessionId: RefObject<string | null>
  latestTransport: RefObject<NativeChatSessionTransport>
  transcriptEpochRef: RefObject<number>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  setRead: Dispatch<SetStateAction<ReadState>>
  setHasMore: Dispatch<SetStateAction<boolean>>
}) {
  // Concurrent callers share the current epoch’s page.
  const olderPageRef = useRef<{
    epoch: number
    promise: Promise<NativeChatOlderPageResult>
  } | null>(null)
  return useCallback((): Promise<NativeChatOlderPageResult> => {
    const inFlight = olderPageRef.current
    if (inFlight?.epoch === transcriptEpochRef.current) {
      return inFlight.promise
    }
    if (!hasMore) {
      return Promise.resolve('exhausted')
    }
    if (
      !latestEnabled.current ||
      !sessionId ||
      read.phase !== 'ready' ||
      read.sourceKey !== sourceKey
    ) {
      return Promise.resolve('unchanged')
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    const requestEpoch = transcriptEpochRef.current
    const requestSourceKey = sourceKey
    const lifecycleRevision = transcriptLifecycleControl.revision()
    const loadedCount = read.messages.length
    setLoadingEarlier(true)
    const promise = transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined, USER_PAGING)
      .then((result): NativeChatOlderPageResult => {
        if (
          !latestEnabled.current ||
          latestSessionId.current !== sessionId ||
          latestTransport.current !== transport ||
          transcriptEpochRef.current !== requestEpoch
        ) {
          return 'superseded'
        }
        if (!result || 'error' in result) {
          return 'failed'
        }
        limitRef.current = nextLimit
        // Replace the ordered base tail to prepend history; preserve separate live appends.
        setRead({ phase: 'ready', messages: result.messages, sourceKey: requestSourceKey })
        transcriptLifecycleControl.replaceFromPagination(result.lifecycle, lifecycleRevision)
        const more = hasMoreNativeChatHistory(result.messages.length, nextLimit)
        setHasMore(more)
        return result.messages.length > loadedCount ? 'applied' : more ? 'unchanged' : 'exhausted'
      })
      // Keep loaded history when pagination rejects.
      .catch((): NativeChatOlderPageResult => 'failed')
      .finally(() => {
        if (olderPageRef.current?.promise === promise) {
          olderPageRef.current = null
        }
        // Discarded results must still clear loading within the current epoch.
        if (latestEnabled.current && transcriptEpochRef.current === requestEpoch) {
          setLoadingEarlier(false)
        }
      })
    olderPageRef.current = { epoch: requestEpoch, promise }
    return promise
  }, [
    agent,
    sourceKey,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    read,
    transcriptLifecycleControl,
    limitRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    transcriptEpochRef,
    setLoadingEarlier,
    setRead,
    setHasMore
  ])
}
