import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession
} from '../../../../shared/native-chat-types'
import {
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
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatLimit
} from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from './use-native-chat-hook-status'
import {
  bindNativeChatLiveSession,
  type NativeChatReadState
} from './native-chat-live-session-binding'

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
export type NativeChatLiveSession = NativeChatSession & {
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

export type ReadState = NativeChatReadState

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
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestSessionId = useRef<string | null>(sessionId)
  latestSessionId.current = sessionId
  // Tracks the current transport so a load-earlier resolve from a prior host is discarded after an owner flip (session id can stay the same).
  const latestTransport = useRef(transport)
  latestTransport.current = transport
  const transcriptEpochRef = useRef(0)

  // Incremental assembler: suffix-extensions take the fast append path, anything else resets so the cache can't drift from a full rebuild (#17).
  const assemblerRef = useRef(createIncrementalAssembler())
  const appliedTranscriptRef = useRef<readonly NativeChatMessage[]>([])
  const baseSigRef = useRef<string | null>(null)
  const baseMessagesRef = useRef<readonly NativeChatMessage[]>(EMPTY_MESSAGES)

  useEffect(() => {
    transcriptEpochRef.current += 1
    setLoadingEarlier(false)
    transcriptLifecycleControl.reset()
    if (!sessionId) {
      // No session id yet: surface live hook state on an empty transcript; backfills once the id arrives.
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }
    return bindNativeChatLiveSession({
      agent,
      sessionId,
      transcriptPath,
      transport,
      limitRef,
      transcriptEpochRef,
      appendMergerRef,
      transcriptLifecycleControl,
      setRead,
      setHasMore,
      setLoadingEarlier,
      setAppended
    })
  }, [agent, sessionId, transcriptPath, transport, transcriptLifecycleControl])

  const loadEarlier = useCallback(() => {
    if (!sessionId || loadingEarlier || !hasMore || read.phase !== 'ready') {
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
        if (transcriptEpochRef.current === requestEpoch) {
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
  const assembledMessages = useMemo(() => {
    const appendedIds = appended.length > 0 ? new Set(appended.map((m) => m.id)) : null
    const transcript =
      appended.length > 0
        ? [...baseMessages.filter((m) => !appendedIds?.has(m.id)), ...appended]
        : baseMessages
    const baseSig = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged = baseSig !== baseSigRef.current || baseMessages !== baseMessagesRef.current
    const applied = appliedTranscriptRef.current
    const isSuffixExtension =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesPrefix(transcript, applied, applied.length)

    const out = isSuffixExtension
      ? transcript.length > applied.length
        ? applyAppends(assemblerRef.current, transcript.slice(applied.length))
        : assemblerRef.current.messages
      : resetAssembler(assemblerRef.current, transcript)
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
    return { ...session, hasMore, loadingEarlier, loadEarlier, readPhase: read.phase }
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
    loadingEarlier,
    loadEarlier,
    appended
  ])
}
