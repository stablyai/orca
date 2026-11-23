import type { RefObject, Dispatch, SetStateAction } from 'react'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatReadSessionResult } from '../../../../../../../preload/api/native-chat/native-chat-api'
import {
  boundNativeChatWindow,
  replaceList,
  applyAppend,
  type NativeChatMerger
} from '../../../../../../../shared/native-chat/transcript/streaming/native-chat-merge'
import {
  NATIVE_CHAT_INITIAL_LIMIT,
  hasMoreNativeChatHistory,
  withHeldOlderHistory
} from '../../../viewport/history/native-chat-pagination'
import type { ReadState } from './native-chat-live-session-contract'
import type { NativeChatSessionTransport } from './native-chat-session-transport'
import type { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { NativeChatHeldHistoryVerify } from './native-chat-held-history-verify'
import {
  heldNativeChatHistoryDepth,
  heldHistoryRereadBase,
  rereadNativeChatHeldHistory
} from './native-chat-held-history-reread'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'
import { takeNativeChatOpenWake } from '../../../pane/routing/native-chat-open-wake'
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

let subscriptionCounter = 0

export function subscribeNativeChatLiveSession({
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
}: {
  agent: AgentType
  sessionId: string | null
  transcriptPath?: string | null
  enabled: boolean
  sourceKey: string
  transport: NativeChatSessionTransport
  retainedSourceKeyRef: RefObject<string>
  transcriptEpochRef: RefObject<number>
  setOlderHistoryGeneration: Dispatch<SetStateAction<number>>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  limitRef: RefObject<number>
  transcriptLifecycleControl: ReturnType<typeof useNativeChatTranscriptLifecycle>[1]
  setRead: Dispatch<SetStateAction<ReadState>>
  appendMergerRef: RefObject<NativeChatMerger>
  setAppended: Dispatch<SetStateAction<NativeChatMessage[]>>
  setHasMore: Dispatch<SetStateAction<boolean>>
  latestEnabled: RefObject<boolean>
  latestPaneKey: RefObject<string>
  heldRef: RefObject<ReadState>
  historyVerify: RefObject<NativeChatHeldHistoryVerify<NativeChatReadSessionResult> | null>
}): () => void {
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
  // Frames can land before this commit; never join them to another source's rows.
  heldRef.current = { phase: 'loading' }
  setRead(heldRef.current)
  replaceList(appendMergerRef.current, [])
  setAppended([])
  setHasMore(false)
  const wake = { wakeWslDistro: takeNativeChatOpenWake(latestPaneKey.current, sourceKey) }

  let windowMessages: NativeChatMessage[] = []
  let windowHasMore = false
  const verifier = new NativeChatHeldHistoryVerify<NativeChatReadSessionResult>({
    visible: () => !cancelled && latestEnabled.current,
    olderSpan: () => {
      const held = heldRef.current
      const start = held.phase === 'ready' ? held.messages[0]?.transcriptOrder : undefined
      const end = windowMessages[0]?.transcriptOrder
      return start !== undefined && end !== undefined ? { start, end } : undefined
    },
    verify: transport.verifyTranscriptRanges
      ? (ranges, signal) =>
          transport.verifyTranscriptRanges!(
            agent,
            activeSessionId,
            ranges,
            transcriptPath ?? undefined,
            signal
          )
      : undefined,
    reread: (signal) =>
      rereadNativeChatHeldHistory(
        transport,
        agent,
        activeSessionId,
        transcriptPath ?? undefined,
        heldNativeChatHistoryDepth(heldRef.current, appendMergerRef.current.list),
        limitRef.current,
        signal
      ),
    apply: (result, superseded) => {
      const repaired = result && 'messages' in result ? result : undefined
      const messages = repaired
        ? heldHistoryRereadBase(agent, repaired.messages, superseded, {
            held: heldRef.current,
            windowFirst: windowMessages[0],
            liveTail: appendMergerRef.current.list
          })
        : windowMessages
      if (!messages) {
        return false
      }
      // Only the reader's own paging widens the budget; repairs must not ratchet the held-base cap.
      transcriptEpochRef.current++
      setOlderHistoryGeneration(transcriptEpochRef.current)
      setLoadingEarlier(false)
      heldRef.current = { phase: 'ready', messages }
      setRead(heldRef.current)
      setHasMore(
        repaired?.hasMore ?? (repaired ? messages.length >= limitRef.current : windowHasMore)
      )
      return repaired?.ranges
    }
  })
  historyVerify.current = verifier

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
        verifier.reset(messages === result?.messages ? result.ranges : undefined)
        heldRef.current = { phase: 'ready', messages }
        setRead(heldRef.current)
        setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
      })
      .catch((err: unknown) => {
        if (!cancelled && latestEnabled.current && !frameArrived) {
          setRead({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
        }
      })
  }

  loadSession(0)

  const subscriptionId = `native-chat-${++subscriptionCounter}`
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
          verifier.clear()
          // Error frames carry no transcript; leave the independent seed eligible to repair the pane.
          setRead({ phase: 'error', error: frame.error })
          return
        }
        if (frame.type === 'snapshot' && frame.pending === true) {
          verifier.clear()
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
        const more = frame.hasMore || messages !== frame.messages
        const tail = appendMergerRef.current.list
        // A reread of the latest window keeps paged-in history instead of shrinking the reader's view.
        const held = verifier.supported
          ? withHeldOlderHistory(agent, heldRef.current, tail, messages, more)
          : messages
        // Sliding replacements must not grow the held base past the paged depth, the bounded live tail and one window.
        const base =
          held === messages
            ? held
            : boundNativeChatWindow(held, limitRef.current + tail.length + messages.length)
        windowMessages = messages
        windowHasMore = more
        verifier.replacement(
          messages === frame.messages ? frame.ranges : undefined,
          base !== messages
        )
        replaceList(appendMergerRef.current, messages)
        setAppended((current) => (current.length === 0 ? current : []))
        if (heldRef.current.phase !== 'ready' || base !== heldRef.current.messages) {
          heldRef.current = { phase: 'ready', messages: base }
          setRead(heldRef.current)
        }
        setHasMore((current) => (base === messages ? more : current || base !== held))
        return
      }
      if (frame.messages.length > 0 || frame.ranges) {
        verifier.append(frame.ranges)
      }
      transcriptLifecycleControl.append(frame.lifecycle)
      // Bound the deduped append tail; the base read/assembler still cover trimmed turns.
      setAppended(applyAppend(appendMergerRef.current, frame.messages, limitRef.current))
    }
  )

  return () => {
    cancelled = true
    verifier.clear()
    if (historyVerify.current === verifier) {
      historyVerify.current = null
    }
    retryTimer.cancel()
    closeStream()
  }
}
