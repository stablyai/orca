import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { hasMoreNativeChatHistory, NATIVE_CHAT_INITIAL_LIMIT } from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatLoadEarlier } from './use-native-chat-load-earlier'
import { useNativeChatTranscriptOrder } from './use-native-chat-transcript-order'
import {
  createNativeChatAuthoritativeSettle,
  isNativeChatSessionIdAdoption,
  NATIVE_CHAT_NOTFOUND_RETRY_WINDOW_MS
} from './native-chat-live-session-order'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-types'
export type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-types'

const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

/** Windowed readSession + subscribe tail, merged with live hook turn-state. */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, enabled = true } = args
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [transcriptLifecycle, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  const [transcriptOrder, resetTranscriptOrder, appendTranscriptOrder, settleTranscriptOrder] =
    useNativeChatTranscriptOrder()
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))
  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestEnabled = useRef(enabled)
  useLayoutEffect(() => {
    latestEnabled.current = enabled
  }, [enabled])
  const latestSessionId = useRef<string | null>(sessionId)
  latestSessionId.current = sessionId
  const latestTransport = useRef(transport)
  latestTransport.current = transport
  const transcriptEpochRef = useRef(0)
  const previousOrderSourceRef = useRef({
    agent,
    sessionId,
    transcriptPath: transcriptPath ?? null,
    transport
  })
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
    const nextSource = {
      agent,
      sessionId,
      transcriptPath: transcriptPath ?? null,
      transport
    }
    const adoptedSessionId = isNativeChatSessionIdAdoption(
      previousOrderSourceRef.current,
      nextSource
    )
    if (sourceChanged && !adoptedSessionId) {
      resetTranscriptOrder()
    }
    if (!enabled) {
      if (sourceChanged) {
        limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
        transcriptLifecycleControl.reset()
        setRead({ phase: 'loading' })
        replaceList(appendMergerRef.current, [])
        setAppended([])
        setHasMore(false)
      }
      return
    }
    previousOrderSourceRef.current = nextSource
    const authoritativeSettle = createNativeChatAuthoritativeSettle(
      settleTranscriptOrder,
      () => limitRef.current
    )
    if (adoptedSessionId) {
      authoritativeSettle.markAdoptSettle()
    }
    transcriptLifecycleControl.reset()

    if (!sessionId) {
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }

    let cancelled = false
    let frameArrived = false
    const retryTimer = createNativeChatReadRetryTimer()
    const retryStartedAt = Date.now()
    const activeSessionId = sessionId
    if (sourceChanged) {
      limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    }
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    function loadSession(attempt: number): void {
      if (!latestEnabled.current || frameArrived) {
        return
      }
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined)
        .then((result) => {
          if (cancelled || !latestEnabled.current || frameArrived) {
            return
          }
          if (result && 'error' in result) {
            if (
              result.notFound &&
              Date.now() - retryStartedAt < NATIVE_CHAT_NOTFOUND_RETRY_WINDOW_MS
            ) {
              retryTimer.schedule(attempt, () => loadSession(attempt + 1))
              return
            }
            setRead({ phase: 'error', error: result.error })
            return
          }
          const messages = result?.messages ?? []
          transcriptLifecycleControl.replace(result?.lifecycle)
          // Establish a renderer-local baseline for every authoritative read;
          // reconnect snapshots then sequence only first-seen rows beyond it.
          authoritativeSettle.settleFrame(messages, false)
          setRead({ phase: 'ready', messages })
          setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
        })
        .catch((err: unknown) => {
          if (!cancelled && latestEnabled.current && !frameArrived) {
            setRead({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
          }
        })
    }

    loadSession(0)

    const closeStream = openNativeChatTranscriptStream(
      transport,
      {
        subscriptionId: nextSubscriptionId(),
        agent,
        sessionId,
        transcriptPath: transcriptPath ?? undefined,
        limit: limitRef.current
      },
      (frame) => {
        if (cancelled || !latestEnabled.current) {
          return
        }
        if (frame.type === 'snapshot' || frame.type === 'replacement') {
          transcriptEpochRef.current += 1
          setLoadingEarlier(false)
          if ('error' in frame && frame.error) {
            setRead({ phase: 'error', error: frame.error })
            return
          }
          frameArrived = true
          transcriptLifecycleControl.replace(frame.lifecycle)
          replaceList(appendMergerRef.current, frame.messages)
          setAppended([])
          authoritativeSettle.settleFrame(frame.messages, frame.type === 'replacement')
          setRead({ phase: 'ready', messages: appendMergerRef.current.list })
          setHasMore(frame.hasMore)
          return
        }
        transcriptLifecycleControl.append(frame.lifecycle)
        const retained = applyAppend(appendMergerRef.current, frame.messages, limitRef.current)
        appendTranscriptOrder(frame.messages, retained.length)
        setAppended(retained)
      }
    )

    return () => {
      cancelled = true
      retryTimer.cancel()
      closeStream()
    }
  }, [
    agent,
    enabled,
    sessionId,
    sourceKey,
    transcriptPath,
    transport,
    transcriptLifecycleControl,
    resetTranscriptOrder,
    appendTranscriptOrder,
    settleTranscriptOrder
  ])

  const loadEarlier = useNativeChatLoadEarlier({
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    loadingEarlier,
    readPhase: read.phase,
    transcriptLifecycleControl,
    limitRef,
    transcriptEpochRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    setLoadingEarlier,
    setRead,
    setHasMore
  })

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
      hasMore,
      loadingEarlier,
      loadEarlier,
      readPhase: read.phase,
      transcriptOrder
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
    transcriptOrder
  ])
}
