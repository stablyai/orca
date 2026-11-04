import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/agent-session/structured-agent-session-reducer'
import {
  pendingStructuredSessionPrompts,
  projectStructuredAgentSessionMessages
} from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  structuredAgentSessionMessageSendMutation
} from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { MobileChatMessage, MobilePendingInteraction } from './views/MobileChatView'
import {
  callRuntime,
  operationId,
  pendingInteractionFor,
  pickOption,
  toMobileMessage
} from './mobile-session-model'

export type MobileStructuredSession = {
  messages: MobileChatMessage[]
  pendingInteraction: MobilePendingInteraction | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
  sending: boolean
  resolving: boolean
  sendPrompt: (text: string) => Promise<void>
  resolveInteraction: (interactionId: string, decision: 'approve' | 'deny') => Promise<void>
  stop: () => Promise<void>
}

export function useMobileStructuredSession(sessionId: string): MobileStructuredSession {
  const [state, setState] = useState<StructuredAgentSessionState>(EMPTY_STRUCTURED_AGENT_SESSION)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [resolving, setResolving] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const dispatch = useCallback(
    (action: Parameters<typeof reduceStructuredAgentSession>[1]): void => {
      setState((previous) => reduceStructuredAgentSession(previous, action, Date.now()))
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    let handle: { unsubscribe: () => void } | null = null

    dispatch({ type: 'loading' })
    setError(null)

    const start = async (): Promise<void> => {
      try {
        const history = await callRuntime<AgentSessionHistoryResult>('agentSession.history', {
          sessionId,
          direction: 'tail',
          limit: 200
        })
        if (cancelled) {
          return
        }
        if (history.ok) {
          dispatch({ type: 'history-page', page: history.page })
        } else {
          dispatch({
            type: 'event',
            event: {
              type: 'reset',
              sessionId,
              reset: history.reset,
              page: history.page,
              fence: history.fence ?? 0
            }
          })
        }

        handle = await window.api.runtime.subscribe(
          { method: 'agentSession.subscribe', params: { sessionId } },
          (response) => {
            if (cancelled) {
              return
            }
            if (!response.ok) {
              setError(response.error?.message ?? 'Agent transcript stream failed')
              return
            }
            const event = response.result as AgentSessionSubscribeEvent
            dispatch({ type: 'event', event, opensSubscription: true })
          }
        )
        if (cancelled) {
          handle.unsubscribe()
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError))
        }
      }
    }

    void start()

    return () => {
      cancelled = true
      handle?.unsubscribe()
      void window.api.runtime
        .call({ method: 'agentSession.unsubscribe', params: { sessionId } })
        .catch(() => undefined)
    }
  }, [dispatch, sessionId])

  const pendingPrompts = useMemo(
    () =>
      pendingStructuredSessionPrompts({
        journalItems: state.items,
        currentRequests: state.currentRequests,
        actionablePromptIds: state.actionablePromptIds
      }),
    [state.actionablePromptIds, state.currentRequests, state.items]
  )

  const messages = useMemo(
    () =>
      projectStructuredAgentSessionMessages(state.items, [], state.submissions)
        .map(toMobileMessage)
        .filter((message) => message.content || message.reasoning || message.tools),
    [state.items, state.submissions]
  )

  const pendingInteraction = useMemo<MobilePendingInteraction | null>(
    () => pendingInteractionFor(pendingPrompts.at(0)),
    [pendingPrompts]
  )

  const resolveFence = useCallback(async (): Promise<number> => {
    if (stateRef.current.fence !== null) {
      return stateRef.current.fence
    }
    const history = await callRuntime<AgentSessionHistoryResult>('agentSession.history', {
      sessionId,
      direction: 'tail',
      limit: 1
    })
    const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
    if (typeof fence !== 'number') {
      throw new Error('The desktop has not opened this session for writing yet.')
    }
    return fence
  }, [sessionId])

  const sendPrompt = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      if (!trimmed || sending) {
        return
      }
      setSending(true)
      setError(null)
      try {
        const fence = await resolveFence()
        const body = structuredAgentSessionSendBody(trimmed, [])
        const params = structuredAgentSessionMessageSendMutation({
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: fence,
          body
        })
        const result = await callRuntime<AgentSessionMutationResult<unknown>>(
          'agentSession.send',
          params
        )
        if (!result.ok) {
          throw new Error(result.refusal.message)
        }
      } catch (sendError) {
        setError(sendError instanceof Error ? sendError.message : String(sendError))
      } finally {
        setSending(false)
      }
    },
    [resolveFence, sending, sessionId]
  )

  const resolveInteraction = useCallback(
    async (interactionId: string, decision: 'approve' | 'deny'): Promise<void> => {
      const item = pendingPrompts.find((candidate) => candidate.itemId === interactionId)
      if (!item || resolving) {
        return
      }
      setResolving(true)
      setError(null)
      try {
        const option = pickOption(item, decision)
        if (!option) {
          throw new Error('This prompt has no selectable answer.')
        }
        const fence = await resolveFence()
        const method =
          item.body.kind === 'approval'
            ? 'agentSession.respondToApproval'
            : 'agentSession.respondToQuestion'
        const fingerprintMethod = `agentSession.respondTo:${item.body.kind}`
        const fields = {
          itemId: item.itemId,
          expectedRevision: item.revision,
          optionId: option.id
        }
        const result = await callRuntime<AgentSessionMutationResult<unknown>>(method, {
          envelope: {
            sessionId,
            clientOperationId: operationId(),
            expectedRuntimeFence: fence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
        if (!result.ok) {
          throw new Error(result.refusal.message)
        }
      } catch (resolveError) {
        setError(resolveError instanceof Error ? resolveError.message : String(resolveError))
      } finally {
        setResolving(false)
      }
    },
    [pendingPrompts, resolving, resolveFence, sessionId]
  )

  const stop = useCallback(async (): Promise<void> => {
    try {
      const fence = await resolveFence()
      const fields = {}
      const result = await callRuntime<AgentSessionMutationResult<unknown>>('agentSession.cancel', {
        envelope: {
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: fence,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.cancel',
            sessionId,
            fields
          })
        },
        ...fields
      })
      if (!result.ok) {
        throw new Error(result.refusal.message)
      }
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
    }
  }, [resolveFence, sessionId])

  return {
    messages,
    pendingInteraction,
    status: state.status === 'error' ? 'error' : state.status === 'ready' ? 'ready' : 'loading',
    error: error ?? state.error ?? null,
    sending,
    resolving,
    sendPrompt,
    resolveInteraction,
    stop
  }
}
