import { useNativeChatOlderHistory } from '../../../viewport/history/use-native-chat-older-history'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../../../../shared/native-chat/native-chat-types'
import {
  applyAppend,
  boundNativeChatWindow,
  createNativeChatMerger,
  replaceList
} from '../../../../../../../shared/native-chat/native-chat-merge'
import { mergeNativeChatLiveSession } from '../../../../../../../shared/native-chat/native-chat-live-status'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT
} from '../../../viewport/history/native-chat-pagination'
import type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-contract'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from '../../status/use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from '../assembly/use-native-chat-assembled-messages'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'
import { takeNativeChatOpenWake } from '../../../pane/routing/native-chat-open-wake'

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
  if (appendMergerRef.current == null) {
    appendMergerRef.current = createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY)
  }

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestEnabled = useRef(enabled)
  // Read, not a dependency: the source key below already changes with the pane.
  const latestPaneKey = useRef(paneKey)
  // Fence late frames before passive cleanup closes the previous stream.
  useLayoutEffect(() => {
    latestEnabled.current = enabled
    latestPaneKey.current = paneKey
  }, [enabled, paneKey])
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
    const wake = { wakeWslDistro: takeNativeChatOpenWake(latestPaneKey.current, sourceKey) }

    // Seed independently for silent streams, but never overwrite an authoritative frame.
    function loadSession(attempt: number): void {
      if (!latestEnabled.current || frameArrived || transcriptPending) {
        return
      }
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined, wake)
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
          const messages = boundNativeChatWindow(result?.messages ?? [], limitRef.current)
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
        limit: limitRef.current,
        wakeWslDistro: wake.wakeWslDistro
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
          const messages = boundNativeChatWindow(frame.messages, limitRef.current)
          replaceList(appendMergerRef.current, messages)
          setAppended([])
          setRead({ phase: 'ready', messages: appendMergerRef.current.list })
          setHasMore(frame.hasMore || messages !== frame.messages)
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

  const loadEarlier = useNativeChatOlderHistory({
    agent,
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
  })

  const trimHistory = useCallback(() => {
    if (
      !latestEnabled.current ||
      latestSessionId.current !== sessionId ||
      latestTransport.current !== transport
    ) {
      return
    }
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    // Retire pagination without closing the independently owned live stream.
    transcriptEpochRef.current += 1
    setOlderHistoryGeneration(transcriptEpochRef.current)
    setLoadingEarlier(false)
    const merger = appendMergerRef.current
    const bounded = boundNativeChatWindow(merger.list, NATIVE_CHAT_INITIAL_LIMIT)
    const trimmedAppend = bounded !== merger.list
    setRead((current) => {
      if (current.phase !== 'ready') {
        return current
      }
      // Evict the base too when the append prefix is gone, keeping one contiguous suffix.
      const messages = trimmedAppend
        ? []
        : boundNativeChatWindow(current.messages, NATIVE_CHAT_INITIAL_LIMIT)
      return messages === current.messages ? current : { ...current, messages }
    })
    if (trimmedAppend) {
      replaceList(merger, bounded)
      setAppended(merger.list)
    }
    if (
      (read.phase === 'ready' && read.messages.length > NATIVE_CHAT_INITIAL_LIMIT) ||
      trimmedAppend
    ) {
      setHasMore(true)
    }
  }, [read, sessionId, transport])

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
      trimHistory,
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
    trimHistory,
    appended
  ])
}
