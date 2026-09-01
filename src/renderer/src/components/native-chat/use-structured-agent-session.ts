import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session-wire'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import {
  structuredSessionOperationId,
  useStructuredAgentSessionOutbox
} from './use-structured-agent-session-outbox'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
}) {
  const { agent, isVisible, sessionId, target } = args
  // Declared first: the hold is what gives a restored session its provider child back, and the
  // read below is useless for sending until it lands.
  useStructuredAgentSessionHold({
    sessionId,
    target,
    surface: 'desktop-chat',
    enabled: isVisible
  })
  const { state, loadingOlder, loadOlder } = useStructuredAgentSessionRead({
    sessionId,
    target,
    isVisible
  })
  const stateRef = useRef(state)
  const [writeError, setWriteError] = useState<string | null>(null)
  const operationIds = useRef(new Map<string, string>())
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent)
  )
  const activeOptionRecordRef = useRef(optionState.record)
  const optionCatalog = useMemo(() => getAgentSessionOptionCatalog(agent), [agent])
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: state.fence,
    submissions: state.submissions
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent)
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, sessionId, state.fence])

  const mutate = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      operationIdOverride?: string | null
    ): Promise<T | null> => {
      if (stateRef.current.fence === null) {
        return null
      }
      const targetFence = stateRef.current.fence
      const key = `${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId =
        operationIdOverride ?? operationIds.current.get(key) ?? structuredSessionOperationId()
      operationIds.current.set(key, clientOperationId)
      let result: AgentSessionMutationResult<T>
      try {
        result = await callStructuredAgentSession<AgentSessionMutationResult<T>>(target, method, {
          envelope: {
            sessionId,
            clientOperationId,
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        if (stateRef.current.fence === targetFence) {
          setWriteError(error instanceof Error ? error.message : 'Request was not sent')
        }
        return null
      }
      if (!result.ok) {
        if (
          agentSessionRefusalOperationState(fingerprintMethod, result.refusal.code) ===
          'settled-rejected'
        ) {
          operationIds.current.delete(key)
        }
        if (stateRef.current.fence === targetFence) {
          setWriteError(result.refusal.message)
        }
        return null
      }
      if (stateRef.current.fence !== targetFence) {
        return null
      }
      operationIds.current.delete(key)
      setWriteError(null)
      return result.value
    },
    [sessionId, target]
  )

  useEffect(() => {
    if (!isVisible || !optionCatalog) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (!stale) {
          setOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
              : current
          )
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [isVisible, optionCatalog, sessionId, state.fence, target])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      if (
        !canSetStructuredAgentSessionOption(optionState, id, value) ||
        typeof value !== 'string'
      ) {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value }
        )
        if (result && activeOptionRecordRef.current === targetRecord) {
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, result.options ?? { [id]: value })
              : current
          )
        }
        return Boolean(result)
      } finally {
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [mutate, optionState]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      return { snapshot: optionSnapshot }
    },
    [optionSnapshot, setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  const prompts = state.items.filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  return {
    messages: projectStructuredAgentSessionMessages(
      state.items,
      outboxController.outbox,
      state.submissions
    ),
    status: state.status,
    error: state.error ?? writeError ?? outboxController.error,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
    prompts,
    outbox: outboxController.outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: outboxController.send,
    retry: outboxController.retry,
    isWorking: turnId !== null,
    turnId,
    cancel: (turnId: string) => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }),
    respond: (item: StructuredPromptItem, optionId: string) =>
      mutate<AgentSessionPromptResult>(
        item.body.kind === 'approval'
          ? 'agentSession.respondToApproval'
          : 'agentSession.respondToQuestion',
        `agentSession.respondTo:${item.body.kind}`,
        { itemId: item.itemId, expectedRevision: item.revision, optionId }
      ),
    optionSnapshot,
    optionSurface,
    setStructuredOption
  }
}
