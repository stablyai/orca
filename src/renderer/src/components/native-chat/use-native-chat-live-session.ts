import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NativeChatReadSessionResult } from '../../../../preload/api-types'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession
} from '../../../../shared/native-chat-types'
import {
  createNativeChatLoadEarlierController,
  NATIVE_CHAT_LOAD_EARLIER_IDLE,
  startNativeChatLoadEarlier,
  type NativeChatLoadEarlier
} from '../../../../shared/native-chat-load-earlier'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'
import { createNativeChatNotFoundRetryTimer } from './native-chat-not-found-retry-timer'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit
} from './native-chat-pagination'
import {
  getNativeChatSessionTransport,
  openNativeChatSessionSubscription
} from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'

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
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession &
  NativeChatLoadEarlier & {
    /** Changes whenever the transcript or its owning host changes. */
    historySourceKey: string
    /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
     *  outranks (and so hides) 'loading', which would let a consumer deciding from
     *  an empty list treat an in-flight transcript as real history. */
    readPhase: ReadState['phase']
  }

// Stable empty-base reference so a non-ready read doesn't churn the base axis.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

/** True when `whole`'s first `len` entries are referentially identical to `prefix` (a tail-extension), so the assembler can splice just the suffix. */
function sharesPrefix(
  whole: readonly NativeChatMessage[],
  prefix: readonly NativeChatMessage[],
  len: number
): boolean {
  for (let i = 0; i < len; i += 1) {
    if (whole[i] !== prefix[i]) {
      return false
    }
  }
  return true
}

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

// Why: a new session's transcript can take minutes to appear on disk (#8401); a `notFound` miss retries with backoff until the window below elapses.
const NOTFOUND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const NOTFOUND_RETRY_FIXED_DELAY_MS = 10_000
const NOTFOUND_RETRY_WINDOW_MS = 60_000

function notFoundRetryDelayMs(attempt: number): number {
  return NOTFOUND_RETRY_DELAYS_MS[attempt] ?? NOTFOUND_RETRY_FIXED_DELAY_MS
}

export type ReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

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
 * Teardown: subscription closes on unmount and on owner/agent/sessionId change so
 * a swap or owner-flip never leaks a watcher.
 */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId } = args
  const historySourceKey = `${runtimeEnvironmentId ?? ''}\0${agent}\0${sessionId ?? ''}\0${transcriptPath ?? ''}`
  // Stable per owner id so a re-render without an owner flip keeps the same transport and doesn't re-subscribe.
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadEarlierState, setLoadEarlierState] = useState(NATIVE_CHAT_LOAD_EARLIER_IDLE)
  const [loadEarlierController] = useState(createNativeChatLoadEarlierController)
  const [transcriptLifecycle, transcriptLifecycleControl] = useNativeChatTranscriptLifecycle()
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  // Appended messages accumulate separately from the snapshot so pagination doesn't lose in-flight appends; merged by id and capped to the read window (#6).
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Id-dedup merger backing `appended`; caches the id→index map so each live frame costs O(incoming), not O(existing) (#18).
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  // Incremental assembler: suffix-extensions take the fast append path, anything else resets so the cache can't drift from a full rebuild (#17).
  const assemblerRef = useRef(createIncrementalAssembler())
  const appliedTranscriptRef = useRef<readonly NativeChatMessage[]>([])
  const baseSigRef = useRef<string | null>(null)
  const baseMessagesRef = useRef<readonly NativeChatMessage[]>(EMPTY_MESSAGES)

  useLayoutEffect(() => {
    loadEarlierController.invalidate()
  }, [agent, sessionId, transcriptPath, transport, loadEarlierController])

  useEffect(() => {
    setLoadEarlierState(NATIVE_CHAT_LOAD_EARLIER_IDLE)
    transcriptLifecycleControl.reset()

    if (!sessionId) {
      // No session id yet: surface live hook state on an empty transcript; backfills once the id arrives.
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }

    let cancelled = false
    // Set by the first authoritative frame so the readSession seed below can't clobber a live snapshot.
    let frameArrived = false
    const retryStartedAt = Date.now()
    const retryTimer = createNativeChatNotFoundRetryTimer()
    // Re-bound as a const: TS drops the `!sessionId` narrowing inside the hoisted nested function.
    const activeSessionId = sessionId
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    // Independent initial seed in case subscribe never delivers a snapshot; applied only until an authoritative frame lands so a live snapshot wins.
    function loadSession(attempt: number): void {
      if (frameArrived) {
        return
      }
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined)
        .then((result) => {
          if (cancelled || frameArrived) {
            return
          }
          if (result && 'error' in result) {
            // A not-yet-flushed transcript: stay in 'loading' and retry with backoff instead of a permanent error (#8401).
            if (result.notFound && Date.now() - retryStartedAt < NOTFOUND_RETRY_WINDOW_MS) {
              retryTimer.schedule(() => {
                loadSession(attempt + 1)
              }, notFoundRetryDelayMs(attempt))
              return
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
          if (!cancelled && !frameArrived) {
            setRead({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
          }
        })
    }

    loadSession(0)

    const subscriptionId = nextSubscriptionId()
    const unsubscribe = openNativeChatSessionSubscription(
      transport,
      {
        subscriptionId,
        agent,
        sessionId,
        transcriptPath: transcriptPath ?? undefined,
        limit: limitRef.current
      },
      (frame) => {
        if (!cancelled) {
          if (frame.type === 'snapshot' || frame.type === 'replacement') {
            // Why: snapshots and inode replacements are authoritative generations; older pagination must not repaint them.
            frameArrived = true
            loadEarlierController.invalidate()
            setLoadEarlierState(NATIVE_CHAT_LOAD_EARLIER_IDLE)
            if ('error' in frame && frame.error) {
              setRead({ phase: 'error', error: frame.error })
              return
            }
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
      }
    )

    return () => {
      cancelled = true
      retryTimer.cancel()
      unsubscribe()
    }
    // `transport` identity changes on an owner flip, re-running this effect to re-subscribe against the new host.
  }, [
    agent,
    sessionId,
    transcriptPath,
    transport,
    loadEarlierController,
    transcriptLifecycleControl
  ])

  const loadEarlier = useCallback(() => {
    if (!sessionId || !hasMore || read.phase !== 'ready') {
      return
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    const lifecycleRevision = transcriptLifecycleControl.revision()
    startNativeChatLoadEarlier({
      controller: loadEarlierController,
      read: () => transport.readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined),
      isSuccess: (
        result
      ): result is Extract<NativeChatReadSessionResult, { messages: NativeChatMessage[] }> =>
        result !== null && !('error' in result),
      apply: (result) => {
        limitRef.current = nextLimit
        // Read results are an ordered tail: replace the base list so the older page prepends in order; live appends stay separate.
        setRead({ phase: 'ready', messages: result.messages })
        transcriptLifecycleControl.replaceFromPagination(result.lifecycle, lifecycleRevision)
        setHasMore(hasMoreNativeChatHistory(result.messages.length, nextLimit))
      },
      setState: setLoadEarlierState
    })
  }, [
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    read.phase,
    loadEarlierController,
    transcriptLifecycleControl
  ])

  // Computed outside the status memo so hookState churn (status-only) never re-runs the assembler.
  const baseMessages = read.phase === 'ready' ? read.messages : EMPTY_MESSAGES
  const assembledMessages = useMemo(() => {
    const transcript =
      appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
    // Base-axis signature: any change forces a full assembler reset so a missed trigger can't leave the cache stale.
    const baseSig = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged = baseSig !== baseSigRef.current || baseMessages !== baseMessagesRef.current
    const applied = appliedTranscriptRef.current
    const isSuffixExtension =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesPrefix(transcript, applied, applied.length)

    let out: NativeChatMessage[]
    if (isSuffixExtension && transcript.length > applied.length) {
      out = applyAppends(assemblerRef.current, transcript.slice(applied.length))
    } else if (isSuffixExtension) {
      out = assemblerRef.current.messages
    } else {
      out = resetAssembler(assemblerRef.current, transcript)
    }
    baseSigRef.current = baseSig
    baseMessagesRef.current = baseMessages
    appliedTranscriptRef.current = transcript
    return out
    // baseMessages/appended are the only message-set inputs; sessionId/agent gate the reset. hookState intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseMessages, appended, sessionId, agent])

  // Why: skill invocations are user turns but Claude records them as noise-filtered command envelopes, so surface them as the literal token here.
  const surfacedMessages = useMemo(
    () =>
      surfaceSkillInvocationUserTurns(
        assembledMessages,
        new Set(getVerifiedNativeChatCommands(agent).map((command) => command.name))
      ),
    [assembledMessages, agent]
  )

  return useMemo<NativeChatLiveSession>(() => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: surfacedMessages },
      sessionId,
      agent,
      hookState,
      stateStartedAt: hookStateStartedAt,
      transcriptLifecycle,
      hookHasWorkingSubagents,
      // Why: show live watcher-append content over a spinner/stale error (#8401), so overrides apply only when nothing is appended.
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return {
      ...session,
      hasMore,
      ...loadEarlierState,
      loadEarlier,
      historySourceKey,
      readPhase: read.phase
    }
  }, [
    surfacedMessages,
    read,
    sessionId,
    agent,
    hookState,
    hookStateStartedAt,
    transcriptLifecycle,
    hookHasWorkingSubagents,
    hasMore,
    loadEarlierState,
    loadEarlier,
    historySourceKey,
    appended
  ])
}
