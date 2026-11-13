import { useEffect, type RefObject, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import {
  applyAppend,
  boundNativeChatWindow,
  replaceList,
  type createNativeChatMerger
} from '../../../../../../../shared/native-chat/native-chat-merge'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT
} from '../../../viewport/history/native-chat-pagination'
import type { ReadState, UseNativeChatLiveSessionArgs } from './native-chat-live-session-contract'
import type { getNativeChatSessionTransport } from './native-chat-session-transport'
import type { useNativeChatTranscriptLifecycle } from './use-native-chat-transcript-lifecycle'
import { createNativeChatReadRetryTimer } from './native-chat-read-retry-timer'
import { openNativeChatTranscriptStream } from './native-chat-stream-teardown'
import { takeNativeChatOpenWake } from '../../../pane/routing/native-chat-open-wake'
let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

// New transcripts may take minutes to flush (#8401); explicit host-pending frames override this guessed retry window.
export const NOTFOUND_RETRY_WINDOW_MS = 60_000

export function useNativeChatLiveTranscript({
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
}: {
  agent: UseNativeChatLiveSessionArgs['agent']
  enabled: boolean
  sessionId: string | null
  sourceKey: string
  transcriptPath: UseNativeChatLiveSessionArgs['transcriptPath']
  transport: ReturnType<typeof getNativeChatSessionTransport>
  transcriptLifecycleControl: ReturnType<typeof useNativeChatTranscriptLifecycle>[1]
  limitRef: RefObject<number>
  latestEnabled: RefObject<boolean>
  latestPaneKey: RefObject<string>
  retainedSourceKeyRef: RefObject<string>
  appendMergerRef: RefObject<ReturnType<typeof createNativeChatMerger>>
  transcriptEpochRef: RefObject<number>
  setOlderHistoryGeneration: Dispatch<SetStateAction<number>>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  setRead: Dispatch<SetStateAction<ReadState>>
  setAppended: Dispatch<SetStateAction<NativeChatMessage[]>>
  setHasMore: Dispatch<SetStateAction<boolean>>
}): void {
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
        setRead({ sourceKey, phase: 'loading' })
        replaceList(appendMergerRef.current, [])
        setAppended([])
        setHasMore(false)
      }
      return () => undefined
    }
    transcriptLifecycleControl.reset()
    if (!sessionId) {
      setRead({ sourceKey, phase: 'ready', messages: [] })
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
    setRead({ sourceKey, phase: 'loading' })
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
            setRead({ sourceKey, phase: 'error', error: result.error })
            return
          }
          const messages = boundNativeChatWindow(result?.messages ?? [], limitRef.current)
          transcriptLifecycleControl.replace(result?.lifecycle)
          setRead({ sourceKey, phase: 'ready', messages })
          setHasMore(hasMoreNativeChatHistory(messages.length, limitRef.current))
        })
        .catch((err: unknown) => {
          if (!cancelled && latestEnabled.current && !frameArrived) {
            setRead({
              sourceKey,
              phase: 'error',
              error: err instanceof Error ? err.message : String(err)
            })
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
            setRead({ sourceKey, phase: 'error', error: frame.error })
            return
          }
          if (frame.type === 'snapshot' && frame.pending === true) {
            // Pending ends the spinner without consuming the in-flight seed or appended tail.
            transcriptPending = true
            // The host resolve poll owns recovery; stop duplicate renderer filesystem probes.
            retryTimer.cancel()
            setRead({ sourceKey, phase: 'awaiting' })
            return
          }
          frameArrived = true
          transcriptLifecycleControl.replace(frame.lifecycle)
          const messages = boundNativeChatWindow(frame.messages, limitRef.current)
          replaceList(appendMergerRef.current, messages)
          setAppended([])
          setRead({ sourceKey, phase: 'ready', messages: appendMergerRef.current.list })
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
  }, [
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
  ])
}
