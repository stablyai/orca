import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type {
  AgentType,
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../../shared/native-chat-types'
import {
  applyAppend,
  replaceList,
  type NativeChatMerger
} from '../../../../shared/native-chat-merge'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT
} from './native-chat-pagination'
import type { NativeChatSessionTransport } from './native-chat-session-transport'

export type NativeChatReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

type TranscriptLifecycleBindingControl = {
  replace: (lifecycle: NativeChatTurnLifecycle | undefined) => void
  append: (lifecycle: NativeChatTurnLifecycle | undefined) => void
}

type BindNativeChatLiveSessionArgs = {
  agent: AgentType
  sessionId: string
  transcriptPath?: string | null
  transport: NativeChatSessionTransport
  limitRef: MutableRefObject<number>
  transcriptEpochRef: MutableRefObject<number>
  appendMergerRef: MutableRefObject<NativeChatMerger>
  transcriptLifecycleControl: TranscriptLifecycleBindingControl
  setRead: Dispatch<SetStateAction<NativeChatReadState>>
  setHasMore: Dispatch<SetStateAction<boolean>>
  setLoadingEarlier: Dispatch<SetStateAction<boolean>>
  setAppended: Dispatch<SetStateAction<NativeChatMessage[]>>
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const RETRY_FIXED_DELAY_MS = 10_000
const RETRY_WINDOW_MS = 60_000

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

function retryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? RETRY_FIXED_DELAY_MS
}

export function bindNativeChatLiveSession(
  args: BindNativeChatLiveSessionArgs
): () => void {
  const {
    agent,
    sessionId: activeSessionId,
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
  } = args
  let cancelled = false
  let frameArrived = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const retryStartedAt = Date.now()
  limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
  setRead({ phase: 'loading' })
  replaceList(appendMergerRef.current, [])
  setAppended([])
  setHasMore(false)

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
          if (
            (result.notFound || result.retryable) &&
            Date.now() - retryStartedAt < RETRY_WINDOW_MS
          ) {
            retryTimer = setTimeout(() => {
              retryTimer = null
              loadSession(attempt + 1)
            }, retryDelayMs(attempt))
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
  const unsubscribe = transport.subscribe(
    {
      subscriptionId,
      agent,
      sessionId: activeSessionId,
      transcriptPath: transcriptPath ?? undefined,
      limit: limitRef.current
    },
    (frame) => {
      if (cancelled) {
        return
      }
      if (frame.type === 'snapshot' || frame.type === 'replacement') {
        frameArrived = true
        transcriptEpochRef.current += 1
        setLoadingEarlier(false)
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
      setAppended(applyAppend(appendMergerRef.current, frame.messages, limitRef.current))
    }
  )

  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
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
}
