import { useNativeChatLiveTranscript } from './use-native-chat-live-transcript'
export { NOTFOUND_RETRY_WINDOW_MS } from './use-native-chat-live-transcript'
import { useNativeChatOlderHistory } from '../../../viewport/history/use-native-chat-older-history'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../../../../shared/native-chat/native-chat-types'
import {
  boundNativeChatWindow,
  createNativeChatMerger,
  replaceList
} from '../../../../../../../shared/native-chat/native-chat-merge'
import { mergeNativeChatLiveSession } from '../../../../../../../shared/native-chat/native-chat-live-status'
import { NATIVE_CHAT_INITIAL_LIMIT } from '../../../viewport/history/native-chat-pagination'
import type {
  NativeChatLiveSession,
  ReadState,
  UseNativeChatLiveSessionArgs
} from './native-chat-live-session-contract'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { useNativeChatHookStatus } from '../../status/use-native-chat-hook-status'
import { useNativeChatAssembledMessages } from '../assembly/use-native-chat-assembled-messages'

// Keep the base axis stable through non-ready reads.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

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
    args.targetPtyId ?? null,
    runtimeEnvironmentId ?? null,
    agent,
    sessionId,
    transcriptPath ?? null
  ])
  const retainedSourceKeyRef = useRef(sourceKey)
  const sourceMatches = retainedSourceKeyRef.current === sourceKey

  useNativeChatLiveTranscript({
    agent,
    enabled,
    sessionId,
    sourceKey,
    transcriptPath,
    transport,
    transcriptLifecycleControl,
    limitRef,
    latestEnabled,
    latestPaneKey,
    retainedSourceKeyRef,
    appendMergerRef,
    transcriptEpochRef,
    setOlderHistoryGeneration,
    setLoadingEarlier,
    setRead,
    setAppended,
    setHasMore
  })

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
  const { assembledMessages, normalizedMessages, sourceObservation } =
    useNativeChatAssembledMessages({
      agent,
      sessionId,
      baseMessages,
      appended
    })
  const capturedSourceObservation = useMemo(
    () =>
      sourceMatches && read.phase === 'ready'
        ? {
            ...sourceObservation,
            context: {
              owner: sourceKey,
              sessionId,
              targetPtyId: args.targetPtyId ?? null,
              runtimeEnvironmentId: runtimeEnvironmentId ?? null
            }
          }
        : undefined,
    [
      sourceMatches,
      read.phase,
      sourceObservation,
      sourceKey,
      sessionId,
      args.targetPtyId,
      runtimeEnvironmentId
    ]
  )

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
      sourceObservation: capturedSourceObservation,
      hasMore,
      loadingEarlier,
      olderHistoryGeneration,
      loadEarlier,
      trimHistory,
      readPhase: sourceMatches ? read.phase : 'loading'
    }
  }, [
    normalizedMessages,
    capturedSourceObservation,
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
    appended,
    sourceMatches
  ])
}
