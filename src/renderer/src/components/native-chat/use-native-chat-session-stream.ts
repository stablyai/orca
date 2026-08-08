import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit
} from './native-chat-pagination'
import {
  getNativeChatSessionTransport,
  type NativeChatSessionTransport
} from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'
import { mergeNativeChatSessionContext } from './native-chat-session-context-merge'
import { nextNativeChatSubscriptionId } from './native-chat-subscription-id'

export { mergeNativeChatSessionContext } from './native-chat-session-context-merge'

export type UseNativeChatSessionStreamArgs = {
  paneKey: string
  agent: AgentType
  sessionId: string | null
  transcriptPath?: string | null
  runtimeEnvironmentId?: string | null
  enabled?: boolean
}

export type NativeChatReadState =
  | { phase: 'loading' }
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

export function isNativeChatTranscriptUnsettled(phase: NativeChatReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}

export const NOTFOUND_RETRY_WINDOW_MS = 60_000

export function useNativeChatSessionStream(args: UseNativeChatSessionStreamArgs): {
  read: NativeChatReadState
  context: AgentSessionContextSnapshot
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier: () => void
  markCompactionRequested: () => void
  appended: NativeChatMessage[]
  transcriptLifecycle: ReturnType<typeof useNativeChatTranscriptLifecycle>[0]
} {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, enabled = true } = args
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<NativeChatReadState>({ phase: 'loading' })
  const [context, setContext] = useState(EMPTY_AGENT_SESSION_CONTEXT)
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  const [transcriptLifecycle, lifecycle] = useNativeChatTranscriptLifecycle()
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)
  const [appendMerger] = useState(() => createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))
  const latestSessionId = useRef(sessionId)
  const latestEnabled = useRef(enabled)
  useLayoutEffect(() => {
    latestEnabled.current = enabled
  }, [enabled])
  const latestTransport = useRef<NativeChatSessionTransport>(transport)
  const transcriptEpochRef = useRef(0)
  latestSessionId.current = sessionId
  latestTransport.current = transport
  const sourceKey = JSON.stringify([
    paneKey,
    runtimeEnvironmentId ?? null,
    agent,
    sessionId,
    transcriptPath ?? null
  ])
  const retainedSourceKeyRef = useRef(sourceKey)

  useEffect(() => {
    transcriptEpochRef.current += 1
    setLoadingEarlier(false)
    const sourceChanged = retainedSourceKeyRef.current !== sourceKey
    retainedSourceKeyRef.current = sourceKey
    if (!enabled) {
      if (sourceChanged) {
        limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
        setContext(EMPTY_AGENT_SESSION_CONTEXT)
        lifecycle.reset()
        setRead({ phase: 'loading' })
        replaceList(appendMerger, [])
        setAppended([])
        setHasMore(false)
      }
      return () => undefined
    }
    if (sourceChanged) {
      setContext(EMPTY_AGENT_SESSION_CONTEXT)
    }
    lifecycle.reset()
    if (!sessionId) {
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMerger, [])
      setAppended([])
      setHasMore(false)
      return (): void => {}
    }

    let cancelled = false
    let frameArrived = false
    let transcriptPending = false
    const retryTimer = createNativeChatReadRetryTimer()
    const retryStartedAt = Date.now()
    const activeSessionId = sessionId
    if (sourceChanged) {
      limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    }
    setRead({ phase: 'loading' })
    replaceList(appendMerger, [])
    setAppended([])
    setHasMore(false)

    function loadSession(attempt: number): void {
      if (!latestEnabled.current || frameArrived || transcriptPending) {
        return
      }
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined, paneKey)
        .then((result) => {
          if (cancelled || !latestEnabled.current || frameArrived) {
            return
          }
          if (result && 'error' in result) {
            if (result.notFound) {
              if (transcriptPending) {
                return
              }
              if (Date.now() - retryStartedAt < NOTFOUND_RETRY_WINDOW_MS) {
                retryTimer.schedule(attempt, () => loadSession(attempt + 1))
                return
              }
            }
            setRead({ phase: 'error', error: result.error })
            return
          }
          const nextContext = result?.context
          if (nextContext) {
            setContext((current) => mergeNativeChatSessionContext(current, nextContext))
          }
          const messages = result?.messages ?? []
          lifecycle.replace(result?.lifecycle)
          setRead({ phase: 'ready', messages })
          setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
        })
        .catch((error: unknown) => {
          if (!cancelled && latestEnabled.current && !frameArrived) {
            setRead({
              phase: 'error',
              error: error instanceof Error ? error.message : String(error)
            })
          }
        })
    }

    loadSession(0)
    const closeStream = openNativeChatTranscriptStream(
      transport,
      {
        subscriptionId: nextNativeChatSubscriptionId(),
        agent,
        sessionId,
        transcriptPath: transcriptPath ?? undefined,
        paneKey,
        limit: limitRef.current
      },
      (frame) => {
        if (cancelled || !latestEnabled.current) {
          return
        }
        const nextContext = frame.context
        if (nextContext) {
          setContext((current) => mergeNativeChatSessionContext(current, nextContext))
        }
        if (frame.type === 'snapshot' || frame.type === 'replacement') {
          transcriptEpochRef.current += 1
          setLoadingEarlier(false)
          if ('error' in frame && frame.error) {
            setRead({ phase: 'error', error: frame.error })
            return
          }
          if (frame.type === 'snapshot' && frame.pending === true) {
            transcriptPending = true
            retryTimer.cancel()
            setRead({ phase: 'awaiting' })
            return
          }
          frameArrived = true
          lifecycle.replace(frame.lifecycle)
          replaceList(appendMerger, frame.messages)
          setAppended([])
          setRead({ phase: 'ready', messages: appendMerger.list })
          setHasMore(frame.hasMore)
          return
        }
        lifecycle.append(frame.lifecycle)
        setAppended(applyAppend(appendMerger, frame.messages, limitRef.current))
      }
    )

    return () => {
      cancelled = true
      retryTimer.cancel()
      closeStream()
    }
  }, [
    agent,
    appendMerger,
    enabled,
    paneKey,
    sessionId,
    sourceKey,
    transcriptPath,
    transport,
    lifecycle
  ])

  const loadEarlier = useCallback(() => {
    if (
      !latestEnabled.current ||
      !sessionId ||
      loadingEarlier ||
      !hasMore ||
      read.phase !== 'ready'
    ) {
      return
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    const requestEpoch = transcriptEpochRef.current
    const lifecycleRevision = lifecycle.revision()
    setLoadingEarlier(true)
    void transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined, paneKey)
      .then((result) => {
        if (
          !latestEnabled.current ||
          latestSessionId.current !== sessionId ||
          latestTransport.current !== transport ||
          transcriptEpochRef.current !== requestEpoch ||
          !result ||
          'error' in result
        ) {
          return
        }
        const nextContext = result.context
        if (nextContext) {
          setContext((current) => mergeNativeChatSessionContext(current, nextContext))
        }
        limitRef.current = nextLimit
        setRead({ phase: 'ready', messages: result.messages })
        lifecycle.replaceFromPagination(result.lifecycle, lifecycleRevision)
        setHasMore(hasMoreNativeChatHistory(result.messages.length, nextLimit))
      })
      .catch(() => undefined)
      .finally(() => {
        if (latestEnabled.current && transcriptEpochRef.current === requestEpoch) {
          setLoadingEarlier(false)
        }
      })
  }, [
    agent,
    paneKey,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    loadingEarlier,
    read.phase,
    lifecycle
  ])

  const markCompactionRequested = useCallback(() => {
    setContext((current) => ({
      ...current,
      compaction: 'requested',
      compactionUpdatedAt: Date.now(),
      error: undefined
    }))
  }, [])

  return {
    read,
    context,
    hasMore,
    loadingEarlier,
    loadEarlier,
    markCompactionRequested,
    appended,
    transcriptLifecycle
  }
}
