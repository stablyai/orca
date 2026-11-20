import { useNativeChatOlderHistory } from '../../../viewport/history/use-native-chat-older-history'
import { trimNativeChatHistory } from '../../../viewport/history/native-chat-history-trim'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../../../../shared/native-chat/native-chat-types'
import { createNativeChatMerger } from '../../../../../../../shared/native-chat/transcript/streaming/native-chat-merge'
import { mergeNativeChatLiveSession } from '../../../../../../../shared/native-chat/transcript/streaming/native-chat-live-status'
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
import { subscribeNativeChatLiveSession } from './native-chat-live-subscription'
import type { NativeChatHeldHistoryVerify } from './native-chat-held-history-verify'
import type { TranscriptByteRange } from '../../../../../../../shared/native-chat/transcript/transcript-byte-range'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'

// Keep the base axis stable through non-ready reads.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

// New transcripts may take minutes to flush (#8401); explicit host-pending frames override this guessed retry window.
export { NOTFOUND_RETRY_WINDOW_MS } from './native-chat-live-subscription'

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
  const heldRef = useRef(read)
  const historyVerify = useRef<NativeChatHeldHistoryVerify<NativeChatReadSessionResult> | null>(
    null
  )
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

  useLayoutEffect(
    () => () => {
      historyVerify.current?.clear()
    },
    [sourceKey, transport, enabled]
  )

  useEffect(() => {
    return subscribeNativeChatLiveSession({
      agent,
      sessionId,
      transcriptPath,
      enabled,
      sourceKey,
      transport,
      retainedSourceKeyRef,
      transcriptEpochRef,
      setOlderHistoryGeneration,
      setLoadingEarlier,
      limitRef,
      transcriptLifecycleControl,
      setRead,
      appendMergerRef,
      setAppended,
      setHasMore,
      latestEnabled,
      latestPaneKey,
      heldRef,
      historyVerify
    })
  }, [agent, enabled, sessionId, sourceKey, transcriptPath, transport, transcriptLifecycleControl])

  useLayoutEffect(() => {
    heldRef.current = read
  }, [read, olderHistoryGeneration])

  const onHistoryRead = useCallback(
    (ranges: TranscriptByteRange[] | undefined, prepend: boolean) => {
      if (prepend) {
        historyVerify.current?.prepend(ranges)
      } else {
        historyVerify.current?.reread(ranges)
      }
    },
    []
  )

  const loadEarlier = useNativeChatOlderHistory({
    agent,
    sessionId,
    transcriptPath,
    transport,
    hasMore,
    read,
    heldRef,
    liveTailRef: appendMergerRef,
    olderHistoryGeneration,
    transcriptLifecycleControl,
    limitRef,
    latestEnabled,
    latestSessionId,
    latestTransport,
    transcriptEpochRef,
    setLoadingEarlier,
    setRead,
    setHasMore,
    onHistoryRead
  })

  const trimHistory = useCallback(() => {
    historyVerify.current?.clear()
    trimNativeChatHistory({
      sessionId,
      transport,
      read,
      appendMergerRef,
      limitRef,
      latestEnabled,
      latestSessionId,
      latestTransport,
      transcriptEpochRef,
      setOlderHistoryGeneration,
      setLoadingEarlier,
      setRead,
      setAppended,
      setHasMore
    })
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
