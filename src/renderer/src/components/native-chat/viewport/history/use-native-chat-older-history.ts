import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { ReadState } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatSessionTransport } from '../../session/terminal/read/native-chat-session-transport'
import type { useNativeChatTranscriptLifecycle } from '../../session/terminal/read/use-native-chat-transcript-lifecycle'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_PAGE,
  nativeChatHistoryCursor,
  nativeChatLiveTailJoinsBase,
  type NativeChatOlderPageResult
} from './native-chat-pagination'

const USER_PAGING = { wakeWslDistro: true } as const

export function useNativeChatOlderHistory({
  agent,
  sessionId,
  transcriptPath,
  transport,
  hasMore,
  read,
  liveTailRef,
  olderHistoryGeneration,
  transcriptLifecycleControl,
  limitRef,
  latestEnabled,
  latestSessionId,
  latestTransport,
  transcriptEpochRef,
  setLoadingEarlier,
  setRead,
  setHasMore
}: {
  agent: AgentType
  sessionId: string | null
  transcriptPath?: string | null
  transport: NativeChatSessionTransport
  hasMore: boolean
  read: ReadState
  /** Bounded live-append list; read at page time so streaming does not rebuild the callback. */
  liveTailRef: RefObject<{ list: readonly NativeChatMessage[] }>
  /** The paging epoch this render saw; a mismatch marks a stale callback. */
  olderHistoryGeneration: number
  transcriptLifecycleControl: ReturnType<typeof useNativeChatTranscriptLifecycle>[1]
  limitRef: RefObject<number>
  latestEnabled: RefObject<boolean>
  latestSessionId: RefObject<string | null>
  latestTransport: RefObject<NativeChatSessionTransport>
  transcriptEpochRef: RefObject<number>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  setRead: Dispatch<SetStateAction<ReadState>>
  setHasMore: Dispatch<SetStateAction<boolean>>
}) {
  // Concurrent callers share the current epoch’s page.
  const olderPageRef = useRef<{
    epoch: number
    promise: Promise<NativeChatOlderPageResult>
  } | null>(null)
  // Latest held base, advanced synchronously by applied pages so a retained callback cannot reuse its stale cursor.
  const heldRef = useRef(read)
  // Only a committed new read or paging generation resets it; a render that skipped a queued page leaves it alone.
  useLayoutEffect(() => {
    heldRef.current = read
  }, [read, olderHistoryGeneration])
  return useCallback(
    (pageSize = NATIVE_CHAT_PAGE): Promise<NativeChatOlderPageResult> => {
      // A callback from before a trim, snapshot or rebind holds a base that has since moved.
      if (transcriptEpochRef.current !== olderHistoryGeneration) {
        return Promise.resolve('superseded')
      }
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
      const nextLimit = limitRef.current + pageSize
      const requestEpoch = transcriptEpochRef.current
      const lifecycleRevision = transcriptLifecycleControl.revision()
      const loadedCount = read.messages.length
      const isCurrent = (): boolean =>
        latestEnabled.current &&
        latestSessionId.current === sessionId &&
        latestTransport.current === transport &&
        transcriptEpochRef.current === requestEpoch

      // Grows the whole window from EOF; repairs live-tail gaps and serves routes without row cursors.
      const reread = (): Promise<NativeChatOlderPageResult> =>
        transport
          .readSession(agent, sessionId, nextLimit, transcriptPath ?? undefined, USER_PAGING)
          .then((result): NativeChatOlderPageResult => {
            if (!isCurrent()) {
              return 'superseded'
            }
            if (!result || 'error' in result) {
              return 'failed'
            }
            limitRef.current = nextLimit
            // Replace the ordered base tail to prepend history; preserve separate live appends.
            heldRef.current = { phase: 'ready', messages: result.messages }
            setRead(heldRef.current)
            transcriptLifecycleControl.replaceFromPagination(result.lifecycle, lifecycleRevision)
            const more = hasMoreNativeChatHistory(result.messages.length, nextLimit)
            setHasMore(more)
            return result.messages.length > loadedCount
              ? 'applied'
              : more
                ? 'unchanged'
                : 'exhausted'
          })

      // Reads one page strictly before the oldest held row, so cost stays flat with depth.
      const readPageBefore = (before: number): Promise<NativeChatOlderPageResult> =>
        transport
          .readSession(agent, sessionId, pageSize, transcriptPath ?? undefined, {
            ...USER_PAGING,
            beforeOffset: before
          })
          .then((result): Promise<NativeChatOlderPageResult> | NativeChatOlderPageResult => {
            if (!isCurrent()) {
              return 'superseded'
            }
            if (!result || 'error' in result) {
              return 'failed'
            }
            const held = heldRef.current
            if (
              held.phase !== 'ready' ||
              nativeChatHistoryCursor(agent, held.messages[0]) !== before
            ) {
              return 'superseded'
            }
            // Appends during the read can evict the live tail's overlap; only a full reread fills that gap.
            if (!nativeChatLiveTailJoinsBase(agent, held.messages, liveTailRef.current.list)) {
              return reread()
            }
            const page = result.messages
            // Keep every source row; the assembler resolves shared ids exactly as a full reread would.
            // A rewrite racing this page is corrected by the replacement frame that follows it.
            heldRef.current = { phase: 'ready', messages: [...page, ...held.messages] }
            setRead(heldRef.current)
            limitRef.current = Math.max(limitRef.current, held.messages.length + page.length)
            const more = result.hasMore ?? page.length >= pageSize
            setHasMore(more)
            return page.length > 0 ? 'applied' : more ? 'unchanged' : 'exhausted'
          })

      const heldAtRequest = heldRef.current
      const cursor =
        transport.pagesByCursor &&
        heldAtRequest.phase === 'ready' &&
        nativeChatLiveTailJoinsBase(agent, heldAtRequest.messages, liveTailRef.current.list)
          ? nativeChatHistoryCursor(agent, heldAtRequest.messages[0])
          : undefined

      setLoadingEarlier(true)
      const promise = (cursor === undefined ? reread() : readPageBefore(cursor))
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
    },
    [
      agent,
      sessionId,
      transcriptPath,
      transport,
      hasMore,
      read,
      liveTailRef,
      olderHistoryGeneration,
      transcriptLifecycleControl,
      limitRef,
      latestEnabled,
      latestSessionId,
      latestTransport,
      transcriptEpochRef,
      setLoadingEarlier,
      setRead,
      setHasMore
    ]
  )
}
