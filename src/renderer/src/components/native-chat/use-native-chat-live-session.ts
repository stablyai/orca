import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import { mergeNativeChatLiveSession } from '../../../../shared/native-chat/native-chat-live-status'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit,
  type NativeChatOlderPageResult
} from './native-chat-pagination'
import type { NativeChatLiveSession, ReadState } from './native-chat-live-session-contract'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'

export type { NativeChatLiveSession, ReadState } from './native-chat-live-session-contract'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` hook-entry key. */
  paneKey: string
  agent: AgentType
  /** Null until reported; use live hook state before there is a session to read. */
  sessionId: string | null
  /** Prefer the hook’s authoritative path over reconstruction from sessionId. */
  transcriptPath?: string | null
  /** Non-null routes reads/subscriptions to the owning remote host; null uses local IPC. */
  runtimeEnvironmentId?: string | null
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}

// Keep the base axis stable through non-ready reads.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

// New transcripts may take minutes to flush (#8401); explicit host-pending frames override this guessed retry window.
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

/** Read/tail the owning host’s transcript; pagination replaces the base while separate live appends survive rereads. */
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
  const [olderHistoryGeneration, setOlderHistoryGeneration] = useState(0)
  const [transcriptLifecycle, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  // Separate live appends from snapshots so pagination cannot lose in-flight content.
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Cache the id index so each frame costs O(incoming), not O(existing).
  const appendMergerRef = useRef<ReturnType<typeof createNativeChatMerger>>(undefined!)
  appendMergerRef.current ??= createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY)

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestEnabled = useRef(enabled)
  // Fence late frames before passive cleanup closes the previous stream.
  useLayoutEffect(() => {
    latestEnabled.current = enabled
  }, [enabled])
  const latestSessionId = useRef<string | null>(sessionId)
  latestSessionId.current = sessionId
  // Owner flips can retain sessionId; transport identity must also fence stale pagination.
  const latestTransport = useRef(transport)
  latestTransport.current = transport
  const transcriptEpochRef = useRef(0)
  const sourceKey = JSON.stringify([
    paneKey,
    runtimeEnvironmentId ?? null,
    agent,
    sessionId,
    transcriptPath ?? null
  ])
  const retainedSourceKeyRef = useRef(sourceKey)

  useEffect(() => {
    // Agent/path/owner rebinds may retain sessionId; invalidate every prior pagination generation.
    transcriptEpochRef.current += 1
    setOlderHistoryGeneration(transcriptEpochRef.current)
    setLoadingEarlier(false)
    const sourceChanged = retainedSourceKeyRef.current !== sourceKey
    retainedSourceKeyRef.current = sourceKey
    if (!enabled) {
      if (sourceChanged) {
        limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
        transcriptLifecycleControl.reset()
        setRead({ phase: 'loading' })
        replaceList(appendMergerRef.current, [])
        setAppended([])
        setHasMore(false)
      }
      return () => undefined
    }
    transcriptLifecycleControl.reset()
    if (!sessionId) {
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return () => undefined
    }

    let cancelled = false
    // Authoritative frames outrank the independent read seed.
    let frameArrived = false
    // Host-confirmed missing transcripts are expected until flushed, not errors.
    let transcriptPending = false
    const retryTimer = createNativeChatReadRetryTimer()
    const retryStartedAt = Date.now()
    const activeSessionId = sessionId
    // Reveals retain the paged window; only a new source resets it.
    if (sourceChanged) {
      limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    }
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    // Seed independently for silent streams, but never overwrite an authoritative frame.
    function loadSession(attempt: number): void {
      if (!latestEnabled.current || frameArrived || transcriptPending) {
        return
      }
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined)
        .then((result) => {
          if (cancelled || !latestEnabled.current || frameArrived) {
            return
          }
          if (result && 'error' in result) {
            if (result.notFound) {
              // The live stream owns confirmed missing-file recovery; older hosts need bounded seed retries.
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
          const messages = result?.messages ?? []
          transcriptLifecycleControl.replace(result?.lifecycle)
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

    const subscriptionId = nextSubscriptionId()
    const closeStream = openNativeChatTranscriptStream(
      transport,
      {
        subscriptionId,
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
          // Snapshots/inode replacements start authoritative generations that stale pagination must not repaint.
          transcriptEpochRef.current += 1
          setOlderHistoryGeneration(transcriptEpochRef.current)
          setLoadingEarlier(false)
          if ('error' in frame && frame.error) {
            // Error frames carry no transcript; leave the independent seed eligible to repair the pane.
            setRead({ phase: 'error', error: frame.error })
            return
          }
          if (frame.type === 'snapshot' && frame.pending === true) {
            // Pending ends the spinner without consuming the in-flight seed or appended tail.
            transcriptPending = true
            // The host resolve poll owns recovery; stop duplicate renderer filesystem probes.
            retryTimer.cancel()
            setRead({ phase: 'awaiting' })
            return
          }
          frameArrived = true
          transcriptLifecycleControl.replace(frame.lifecycle)
          replaceList(appendMergerRef.current, frame.messages)
          setAppended([])
          setRead({ phase: 'ready', messages: appendMergerRef.current.list })
          setHasMore(frame.hasMore)
          return
        }
        transcriptLifecycleControl.append(frame.lifecycle)
        // Bound the deduped append tail; the base read/assembler still cover trimmed turns.
        setAppended(applyAppend(appendMergerRef.current, frame.messages, limitRef.current))
      }
    )

    return () => {
      cancelled = true
      retryTimer.cancel()
      closeStream()
    }
  }, [agent, enabled, sessionId, sourceKey, transcriptPath, transport, transcriptLifecycleControl])

  // Concurrent callers share the current epoch’s page.
  const olderPageRef = useRef<{
    epoch: number
    promise: Promise<NativeChatOlderPageResult>
  } | null>(null)
  const loadEarlier = useCallback((): Promise<NativeChatOlderPageResult> => {
    const inFlight = olderPageRef.current
    if (inFlight?.epoch === transcriptEpochRef.current) {
      return inFlight.promise
    }
    if (!hasMore) {
      return Promise.resolve('exhausted')
    }
    if (!latestEnabled.current || !sessionId || read.phase !== 'ready') {
      return Promise.resolve('unchanged')
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    const requestEpoch = transcriptEpochRef.current
    const lifecycleRevision = transcriptLifecycleControl.revision()
    const loadedCount = read.messages.length
    setLoadingEarlier(true)
    const promise = transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined)
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
        setRead({ phase: 'ready', messages: result.messages })
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
  }, [agent, sessionId, transcriptPath, transport, hasMore, read, transcriptLifecycleControl])

  // Keep status-only hook updates from rerunning the assembler.
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
      // Live content outranks stale errors/spinners; apply overrides only before any append (#8401).
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return {
      ...session,
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
    appended
  ])
}
