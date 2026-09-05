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
import { useStructuredSessionOptionsSurface } from './use-structured-session-options-surface'
import {
  isCrossProviderStructuredModelChoice,
  parseStructuredModelChoice
} from '../../../../shared/structured-agent-session-switchable-models'
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
import { useStructuredAgentSessionSwitchableModels } from './use-structured-agent-session-switchable-models'

export type StructuredPromptItem = AgentJournalRenderItem & {
  body: Extract<AgentJournalRenderItem['body'], { kind: 'approval' | 'question' }>
}

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  worktreeId?: string
}) {
  const { agent, isVisible, sessionId, target, worktreeId } = args
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
  const [liveOptions, setLiveOptions] = useState<AgentSessionOptionsResult | null>(null)
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
    setLiveOptions(null)
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
      operationIds.current.delete(key)
      if (stateRef.current.fence !== targetFence && stateRef.current.fence !== result.fence) {
        return null
      }
      setWriteError(null)
      return result.value
    },
    [sessionId, target]
  )

  // Turns are what confirm an option: the provider names the model it is running
  // on the frame that opens each one, so re-read the options as a turn changes
  // rather than leaving the last write unconfirmed for the life of the session.
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const isMonitoringBackgroundTasks =
    turnId === null && state.backgroundTasks?.state === 'monitoring'

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
          setLiveOptions(result)
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
  }, [isVisible, optionCatalog, sessionId, state.fence, target, turnId])

  const baseOptionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )
  const optionSnapshot = useStructuredAgentSessionSwitchableModels({
    agent,
    target,
    worktreeId,
    isVisible,
    snapshot: baseOptionSnapshot,
    live: liveOptions
  })
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      if (typeof value !== 'string') {
        return false
      }
      const cross = id === 'model' ? isCrossProviderStructuredModelChoice(agent, value) : null
      const parsed = id === 'model' ? parseStructuredModelChoice(value) : null
      const optionValue = parsed?.modelId ?? value
      const selected = optionSnapshot.find((option) => option.id === id)
      if (
        cross &&
        (optionState.pendingId !== null ||
          selected?.kind.type !== 'select' ||
          !selected.kind.choices.some((choice) => choice.value === value && !choice.disabled))
      ) {
        return false
      }
      if (!cross && !canSetStructuredAgentSessionOption(optionState, id, optionValue)) {
        return false
      }
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        if (cross) {
          const switched = await mutate(
            'agentSession.switchProvider',
            'agentSession.switchProvider',
            { agent: cross.agent, model: cross.modelId }
          )
          return Boolean(switched)
        }
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: optionValue }
        )
        if (result && activeOptionRecordRef.current === targetRecord) {
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(
                  current,
                  result.options ?? { [id]: optionValue }
                )
              : current
          )
        }
        if (result && id === 'model') {
          const refreshed = await callStructuredAgentSession<AgentSessionOptionsResult>(
            target,
            'agentSession.options',
            { sessionId }
          ).catch(() => null)
          if (
            refreshed &&
            refreshed.current.model === optionValue &&
            activeOptionRecordRef.current === targetRecord &&
            optionCatalog
          ) {
            setLiveOptions(refreshed)
            setOptionState((current) =>
              current.record === targetRecord
                ? applyStructuredAgentSessionOptions(current, optionCatalog, refreshed)
                : current
            )
          }
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
    [agent, mutate, optionCatalog, optionSnapshot, optionState, sessionId, target]
  )
  const optionSurface = useStructuredSessionOptionsSurface(optionSnapshot, setStructuredOption)

  const prompts = state.items.filter(
    (item): item is StructuredPromptItem =>
      (item.body.kind === 'approval' || item.body.kind === 'question') &&
      item.body.resolution.state === 'pending'
  )
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
    isMonitoringBackgroundTasks,
    backgroundTasks: state.backgroundTasks?.tasks ?? [],
    turnId,
    cancel: (turnId: string) => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }),
    stopBackgroundTasks: () =>
      mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks'
      }),
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
