import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  boundNativeChatWindow,
  createNativeChatMerger,
  replaceList
} from '../../../../shared/native-chat-merge'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit
} from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` key — selects the live hook entry. */
  paneKey: string
  agent: AgentType
  /** The agent's own session id, or null before the agent has reported one.
   *  With null there is nothing to read/tail; the view shows live hook state. */
  sessionId: string | null
  /** Authoritative transcript path from the hook (providerSession), preferred
   *  over reconstructing the path from sessionId. Null when not reported. */
  transcriptPath?: string | null
  /** Runtime owner of the pane (Model B). Non-null routes read/subscribe to the
   *  remote runtime host; null/undefined keeps the local IPC path. */
  runtimeEnvironmentId?: string | null
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the read window to page in older history (scrolled-to-top trigger). */
  loadEarlier: () => void
}

// Stable empty-base reference so a non-ready read doesn't churn the base axis.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

/** True when `whole`'s first `len` entries are referentially identical to
 *  `prefix` — i.e. `whole` is `prefix` extended at the tail, so the incremental
 *  assembler can splice just the suffix instead of resetting. */
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

// Why: a brand-new session's transcript can take seconds to minutes to appear
// on disk (#8401), so a `notFound` miss retries — 1s/2s/4s/8s then every 10s —
// until the window below elapses.
const NOTFOUND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const NOTFOUND_RETRY_FIXED_DELAY_MS = 10_000
const NOTFOUND_RETRY_WINDOW_MS = 60_000

function notFoundRetryDelayMs(attempt: number): number {
  return NOTFOUND_RETRY_DELAYS_MS[attempt] ?? NOTFOUND_RETRY_FIXED_DELAY_MS
}

type ReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/**
 * Renderer hook that streams a NativeChatSession for a pane: initial windowed
 * read via `nativeChat.readSession`, live tail via `nativeChat.subscribe`, merged
 * with the pane's live hook turn-state. IO + store reads live here; the merge
 * itself stays pure (mergeNativeChatLiveSession → assembleNativeChatSession).
 *
 * Pagination: the read is windowed to the most recent `limit` turns (default
 * NATIVE_CHAT_INITIAL_LIMIT). `loadEarlier` raises the limit by a page and
 * re-reads to prepend older history; `hasMore` reflects whether the last read
 * filled the window. Read results replace the base list (they are an ordered
 * tail), while live appends accumulate separately so a re-read never drops them.
 *
 * Transport: IO goes through a per-owner session transport selected by
 * getNativeChatSessionTransport. A runtime-owned pane (Model B) reads/tails the
 * REMOTE runtime host via the runtime RPCs; local- and ssh-owned panes keep the
 * local IPC path. The transport preserves the NativeChatApi read/subscribe shape,
 * so everything below (merge, assembler, pagination) is unchanged.
 *
 * Teardown: the subscription is closed on unmount and whenever the owner, agent,
 * or sessionId change, so a toggle back to terminal, a session swap, or an
 * owner-flip never leaks a watcher (remote or local).
 */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId } = args
  // Stable per owner id, so a re-render without an owner flip keeps the same
  // transport identity and doesn't re-subscribe.
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)

  // Appended messages accumulate separately from the initial read so a re-read
  // (session change or load-earlier) doesn't lose in-flight appends mid-swap;
  // they reset with the same effect that re-subscribes. Live frames merge by id
  // (re-emitted ids replace in place, no unbounded concat) and the bucket is
  // capped to the read window so a long run can't grow it without limit (#6).
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Stateful id-dedup merger backing `appended`; caches the id→index map so each
  // live frame costs O(incoming), not O(existing) (#18 parity for desktop).
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))

  // Live hook state for this pane, selected narrowly so unrelated status churn
  // doesn't re-render the chat view.
  const hookState = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.state ?? null)

  const latestSessionId = useRef<string | null>(sessionId)
  latestSessionId.current = sessionId
  // Tracks the current owner's transport so a load-earlier resolve from a prior
  // host is discarded after an owner flip (the session id can stay the same).
  const latestTransport = useRef(transport)
  latestTransport.current = transport

  // Incremental assembler: reset on the base axis (session/agent/read swap),
  // applyAppends on the hot append axis. `appliedTranscriptRef` is the exact
  // array last fed; a pure suffix-extension takes the fast append path, anything
  // else forces a reset so the cache never drifts from a full rebuild (#17).
  const assemblerRef = useRef(createIncrementalAssembler())
  const appliedTranscriptRef = useRef<readonly NativeChatMessage[]>([])
  const baseSigRef = useRef<string | null>(null)
  const baseMessagesRef = useRef<readonly NativeChatMessage[]>(EMPTY_MESSAGES)

  useEffect(() => {
    if (!sessionId) {
      // No session id yet: nothing to read or tail. Surface live hook state on
      // an empty transcript; backfills once the id arrives (effect re-runs).
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const retryStartedAt = Date.now()
    // Re-bound as a plain const: TS doesn't retain the `!sessionId` narrowing
    // above inside a nested function declaration (it's hoisted, so the
    // narrowing can't be proven to hold at every call site).
    const activeSessionId = sessionId
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    function loadSession(attempt: number): void {
      void transport
        .readSession(agent, activeSessionId, limitRef.current, transcriptPath ?? undefined)
        .then((result) => {
          if (cancelled) {
            return
          }
          if (result && 'error' in result) {
            // A not-yet-flushed transcript: stay in 'loading' and retry with
            // backoff instead of settling into a permanent error (#8401).
            if (result.notFound && Date.now() - retryStartedAt < NOTFOUND_RETRY_WINDOW_MS) {
              retryTimer = setTimeout(() => {
                retryTimer = null
                loadSession(attempt + 1)
              }, notFoundRetryDelayMs(attempt))
              return
            }
            setRead({ phase: 'error', error: result.error })
            return
          }
          const messages = result?.messages ?? []
          setRead({ phase: 'ready', messages })
          setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setRead({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
          }
        })
    }

    loadSession(0)

    const subscriptionId = nextSubscriptionId()
    const unsubscribe = transport.subscribe(
      { subscriptionId, agent, sessionId, transcriptPath: transcriptPath ?? undefined },
      (messages) => {
        if (!cancelled) {
          // Merge by id (re-emits replace in place) then bound to the window so
          // the bucket can't grow without limit. The base read still holds older
          // turns, and the assembler re-dedups the concat, so trimming the recent
          // append tail can't drop a turn the base window still covers (#6).
          const merged = applyAppend(appendMergerRef.current, messages)
          const bounded = boundNativeChatWindow(merged, limitRef.current)
          if (bounded !== merged) {
            replaceList(appendMergerRef.current, bounded)
          }
          setAppended(appendMergerRef.current.list)
        }
      }
    )

    return () => {
      cancelled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      // Desktop returns a sync unsubscribe fn; the web RPC bridge returns a
      // Promise instead (and can't deliver streaming callbacks). Calling a
      // Promise as a function crashed the whole chat view, so resolve it first
      // and only call the result when it's actually a function.
      const teardown = unsubscribe as unknown
      if (typeof teardown === 'function') {
        ;(teardown as () => void)()
      } else if (teardown && typeof (teardown as { then?: unknown }).then === 'function') {
        void (teardown as Promise<unknown>).then((fn) => {
          if (typeof fn === 'function') {
            ;(fn as () => void)()
          }
        })
      }
    }
    // `transport` identity changes on an owner flip, re-running this effect to
    // tear down the old host's subscription and open one against the new host.
  }, [agent, sessionId, transcriptPath, transport])

  const loadEarlier = useCallback(() => {
    if (!sessionId || loadingEarlier || !hasMore || read.phase !== 'ready') {
      return
    }
    const nextLimit = nextNativeChatLimit(limitRef.current)
    setLoadingEarlier(true)
    void transport
      .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined)
      .then((result) => {
        // Ignore a stale resolve from a session that swapped OR an owner that
        // flipped underneath us — either would paint the wrong host's history.
        if (latestSessionId.current !== sessionId || latestTransport.current !== transport) {
          return
        }
        if (!result || 'error' in result) {
          return
        }
        limitRef.current = nextLimit
        // Read results are an ordered tail — replace the base list so the older
        // page prepends in order; live appends stay in their separate bucket.
        setRead({ phase: 'ready', messages: result.messages })
        setHasMore(hasMoreNativeChatHistory(result.messages.length, nextLimit))
      })
      .catch(() => {
        // Swallow a rejected earlier-page read (the IPC-backed call can reject):
        // it's a "load more" action, so failing should leave the already-loaded
        // transcript intact rather than surface an unhandled rejection.
      })
      .finally(() => {
        // Always clear the loading flag — even after a session swap — so a stale
        // resolve can't leave loadingEarlier stuck true on the new session. Only
        // APPLYING the result above is gated on the session-id match.
        setLoadingEarlier(false)
      })
  }, [agent, sessionId, transcriptPath, transport, hasMore, loadingEarlier, read.phase])

  // Assembled messages reuse the incremental assembler across appends. Computed
  // outside the status memo: hookState changes only the status override, not the
  // message set, so hook churn never re-runs the assembler (perf note in design).
  const baseMessages = read.phase === 'ready' ? read.messages : EMPTY_MESSAGES
  const assembledMessages = useMemo(() => {
    const transcript =
      appended.length > 0 ? [...baseMessages, ...appended] : (baseMessages as NativeChatMessage[])
    // Base axis: the read's message array reference changes on session swap and
    // loadEarlier; sessionId/agent identify the conversation. Any change forces a
    // full reset so a missed trigger can't leave the cache stale.
    const baseSig = `${agent} ${sessionId ?? ''}`
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
    // baseMessages + appended are the only message-set inputs; sessionId/agent
    // gate the base-axis reset. hookState is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseMessages, appended, sessionId, agent])

  return useMemo<NativeChatLiveSession>(() => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: assembledMessages },
      sessionId,
      agent,
      hookState,
      // Why: a watcher append (fix for #8401) can land content while the read is
      // still retrying ('loading') or after it settled into 'error' — in both
      // cases showing the live content beats a spinner or a stale error, so each
      // override only applies while there is nothing appended to render.
      loading: read.phase === 'loading' && appended.length === 0,
      ...(read.phase === 'error' && appended.length === 0 ? { error: read.error } : {})
    })
    return { ...session, hasMore, loadingEarlier, loadEarlier }
  }, [
    assembledMessages,
    read,
    sessionId,
    agent,
    hookState,
    hasMore,
    loadingEarlier,
    loadEarlier,
    appended
  ])
}
