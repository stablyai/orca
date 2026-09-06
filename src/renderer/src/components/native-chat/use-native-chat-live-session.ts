import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession,
  type NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit
} from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from './use-native-chat-assembled-messages'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` key — selects the live hook entry. */
  paneKey: string
  agent: AgentType
  /** The agent's own session id, or null before it reports one — nothing to read/tail, so the view shows live hook state. */
  sessionId: string | null
  /** Authoritative transcript path from the hook, preferred over reconstructing it from sessionId. Null when not reported. */
  transcriptPath?: string | null
  /** Runtime owner (Model B): non-null routes read/subscribe to the remote host; null keeps the local IPC path. */
  runtimeEnvironmentId?: string | null
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** Latest provider turn boundary, used to settle orphaned running tool rows. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the read window to page in older history (scrolled-to-top trigger). */
  loadEarlier: () => void
  /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
   *  outranks (and so hides) 'loading', which would let a consumer deciding from
   *  an empty list treat an in-flight transcript as real history. */
  readPhase: ReadState['phase']
}

// Stable empty-base reference so a non-ready read doesn't churn the base axis.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

// Why: a new session's transcript can take minutes to appear on disk (#8401).
// Only a guess at the flush delay — a host that reports the transcript pending
// overrides it outright. Exported for tests.
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

export type ReadState =
  | { phase: 'loading' }
  /** The host reported no transcript behind this window yet: rendered, but not a
   *  settled read, so nothing may treat the empty list as real history. */
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** True while no transcript read has settled — 'loading' and 'awaiting' alike.
 *  Consumers that must not act on `messages` as real history use this, not a
 *  bare `!== 'ready'`, which would also swallow the error surface. */
export function isNativeChatTranscriptUnsettled(phase: ReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}

/**
 * Renderer hook that streams a NativeChatSession for a pane: windowed
 * `readSession` + live `subscribe` tail, merged with live hook turn-state.
 *
 * Pagination: read is windowed to the most recent `limit` turns; `loadEarlier`
 * re-reads a larger window to prepend older history. Read results replace the
 * base list; live appends accumulate separately so a re-read never drops them.
 *
 * Transport: per-owner (getNativeChatSessionTransport) — a runtime-owned pane
 * (Model B) reads/tails the remote host; local/ssh panes keep the local IPC path.
 *
 * Teardown: subscription closes when hidden, unmounted, or rebound so no source
 * generation leaks a watcher.
 */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, enabled = true } = args
  // Stable per owner id so a re-render without an owner flip keeps the same transport and doesn't re-subscribe.
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [transcriptLifecycle, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  // Appended messages accumulate separately from the snapshot so pagination doesn't lose in-flight appends; merged by id and capped to the read window (#6).
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Id-dedup merger backing `appended`; caches the id→index map so each live frame costs O(incoming), not O(existing) (#18).
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
  // Tracks the current transport so a load-earlier resolve from a prior host is discarded after an owner flip (session id can stay the same).
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
    // Why: agent/path/owner rebinds can keep the same session; every source generation must invalidate pagination captured before it.
    transcriptEpochRef.current += 1
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
      // No session id yet: surface live hook state on an empty transcript; backfills once the id arrives.
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return () => undefined
    }

    let cancelled = false
    // Set by the first authoritative frame so the readSession seed below can't clobber a live snapshot.
    let frameArrived = false
    // Set once the host reports no transcript on disk yet, which makes a notFound
    // read known-good news rather than a failure worth surfacing.
    let transcriptPending = false
    const retryTimer = createNativeChatReadRetryTimer()
    const retryStartedAt = Date.now()
    // Re-bound as a const: TS drops the `!sessionId` narrowing inside the hoisted nested function.
    const activeSessionId = sessionId
    // Why: a reveal re-reads the same source, so keep the window the user paged in; only a new source starts over.
    if (sourceChanged) {
      limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    }
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    // Independent initial seed in case subscribe never delivers a snapshot; applied only until an authoritative frame lands so a live snapshot wins.
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
              // The live stream owns recovery once it confirms the missing file;
              // an older host gets the bounded seed retry as its fallback.
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
          // Why: snapshots and inode replacements are authoritative generations; older pagination must not repaint them.
          transcriptEpochRef.current += 1
          setLoadingEarlier(false)
          if ('error' in frame && frame.error) {
            // Why: an error frame carries no transcript, so it must not consume the seed — a healthy read still has to repair the pane.
            setRead({ phase: 'error', error: frame.error })
            return
          }
          if (frame.type === 'snapshot' && frame.pending === true) {
            // No transcript exists yet (an agent that hasn't flushed, or was never
            // prompted). Move off 'loading' so the view stops spinning, but keep
            // an in-flight seed and appended tail eligible — this is not a read.
            transcriptPending = true
            // The live resolve-poll stream now owns the eventual initial drain;
            // stop duplicating its filesystem probes forever from the renderer.
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
        // Merge by id then bound to the window; the base read + assembler re-dedup mean trimming the append tail can't drop a covered turn (#6).
        setAppended(applyAppend(appendMergerRef.current, frame.messages, limitRef.current))
      }
    )

    return () => {
      cancelled = true
      retryTimer.cancel()
      closeStream()
    }
    // `transport` identity changes on an owner flip, re-running this effect to re-subscribe against the new host.
  }, [agent, enabled, sessionId, sourceKey, transcriptPath, transport, transcriptLifecycleControl])

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
    const lifecycleRevision = transcriptLifecycleControl.revision()
    setLoadingEarlier(true)
    void transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined)
      .then((result) => {
        // Ignore a stale resolve from a swapped session or flipped owner — either would paint the wrong host's history.
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
        // Read results are an ordered tail: replace the base list so the older page prepends in order; live appends stay separate.
        setRead({ phase: 'ready', messages: result.messages })
        transcriptLifecycleControl.replaceFromPagination(result.lifecycle, lifecycleRevision)
        setHasMore(hasMoreNativeChatHistory(result.messages.length, nextLimit))
      })
      .catch(() => {
        // Swallow a rejected "load more" read: keep the already-loaded transcript intact rather than surface the rejection.
      })
      .finally(() => {
        // Clear the loading flag on the current epoch even when the result is discarded, so a stale resolve can't wedge it true.
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
    read.phase,
    transcriptLifecycleControl
  ])

  // Computed outside the status memo so hookState churn (status-only) never re-runs the assembler.
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
      // Why: show live watcher-append content over a spinner/stale error (#8401), so overrides apply only when nothing is appended.
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return { ...session, hasMore, loadingEarlier, loadEarlier, readPhase: read.phase }
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
    appended
  ])
}
