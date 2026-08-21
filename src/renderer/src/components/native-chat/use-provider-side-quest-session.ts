import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  NativeChatMessage,
  NativeChatSessionStatus
} from '../../../../shared/native-chat-types'
import type { SideQuestStreamEvent } from '../../../../shared/side-quest-runtime-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

function mergeMessages(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  for (const message of incoming) {
    byId.set(message.id, message)
  }
  return Array.from(byId.values()).sort((left, right) => {
    if (left.timestamp === right.timestamp) {
      return 0
    }
    return (left.timestamp ?? 0) - (right.timestamp ?? 0)
  })
}

function applyStreamEvent(
  messages: readonly NativeChatMessage[],
  event: SideQuestStreamEvent
): NativeChatMessage[] {
  if (event.type === 'message-completed') {
    return mergeMessages(messages, [event.message])
  }
  if (event.type !== 'agent-message-delta') {
    return [...messages]
  }
  const existing = messages.find((message) => message.id === event.itemId)
  const priorText = existing?.blocks.find((block) => block.type === 'text')?.text ?? ''
  const streaming: NativeChatMessage = {
    id: event.itemId,
    role: 'assistant',
    blocks: [{ type: 'text', text: `${priorText}${event.delta}` }],
    timestamp: existing?.timestamp ?? Date.now(),
    source: 'hook',
    turnId: event.turnId
  }
  return mergeMessages(messages, [streaming])
}

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `side-quest-${Date.now()}-${subscriptionCounter}`
}

export type ProviderSideQuestSession = {
  session: NativeChatLiveSession
  isWorking: boolean
  send: (text: string, visibleText?: string) => Promise<boolean>
  interrupt: () => Promise<void>
}

export function useProviderSideQuestSession(
  providerThreadId: string | null
): ProviderSideQuestSession {
  const [messages, setMessages] = useState<NativeChatMessage[]>([])
  const [status, setStatus] = useState<NativeChatSessionStatus>(
    providerThreadId ? 'loading' : 'empty'
  )
  const [error, setError] = useState<string | undefined>()
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const activeTurnIdRef = useRef<string | null>(null)
  activeTurnIdRef.current = activeTurnId

  useEffect(() => {
    setMessages([])
    setError(undefined)
    setActiveTurnId(null)
    if (!providerThreadId) {
      setStatus('empty')
      return
    }
    let cancelled = false
    setStatus('loading')
    void window.api.sideQuest
      .read({ providerThreadId })
      .then((result) => {
        if (!cancelled) {
          setMessages((current) => mergeMessages(current, result.messages))
          setStatus(result.messages.length > 0 ? 'ready' : 'empty')
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setStatus('error')
        }
      })

    const unsubscribe = window.api.sideQuest.subscribe(
      { subscriptionId: nextSubscriptionId(), providerThreadId },
      (event) => {
        if (event.type === 'error') {
          setError(event.message)
          setStatus('error')
          setActiveTurnId(null)
          return
        }
        if (event.type === 'turn-completed') {
          setActiveTurnId(null)
          if (event.error) {
            setError(event.error)
            setStatus('error')
          } else {
            setStatus('ready')
          }
          return
        }
        if (event.type === 'agent-message-delta') {
          setActiveTurnId(event.turnId)
        }
        setMessages((current) => applyStreamEvent(current, event))
      }
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [providerThreadId])

  const send = useCallback(
    async (rawText: string, visibleText?: string): Promise<boolean> => {
      const text = rawText.trim()
      if (!providerThreadId || !text || activeTurnIdRef.current) {
        return false
      }
      const messageId = crypto.randomUUID()
      setMessages((current) =>
        mergeMessages(current, [
          {
            id: messageId,
            role: 'user',
            blocks: [{ type: 'text', text: visibleText?.trim() || text }],
            timestamp: Date.now(),
            source: 'hook'
          }
        ])
      )
      setError(undefined)
      setStatus('working')
      // Why: render working state before waiting for turn/start so the UI reacts
      // instantly even if a restarted provider has to resume the durable thread.
      setActiveTurnId('starting')
      try {
        const result = await window.api.sideQuest.send({
          providerThreadId,
          text,
          clientUserMessageId: messageId
        })
        setActiveTurnId((current) => (current === 'starting' ? result.turnId : current))
        return true
      } catch (reason) {
        setActiveTurnId(null)
        setError(reason instanceof Error ? reason.message : String(reason))
        setStatus('error')
        return false
      }
    },
    [providerThreadId]
  )

  const interrupt = useCallback(async (): Promise<void> => {
    const turnId = activeTurnIdRef.current
    if (!providerThreadId || !turnId || turnId === 'starting') {
      return
    }
    await window.api.sideQuest.interrupt({ providerThreadId, turnId })
  }, [providerThreadId])

  const session = useMemo<NativeChatLiveSession>(
    () => ({
      messages,
      status,
      sessionId: providerThreadId,
      agent: 'codex',
      ...(error ? { error } : {}),
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => {},
      readPhase: status === 'loading' ? 'loading' : status === 'error' ? 'error' : 'ready'
    }),
    [error, messages, providerThreadId, status]
  )

  return { session, isWorking: activeTurnId !== null, send, interrupt }
}
