import { patchStructuredAgentSessionOptionSnapshot } from '../../../../shared/structured-agent-session-options'
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
  const [providerOptionSnapshot, setProviderOptionSnapshot] =
    useState<AgentSessionOptionsResult['descriptors']>()
  const optionSnapshotRef = useRef<NonNullable<AgentSessionOptionsResult['descriptors']>>([])
  const pendingOptionRef = useRef<string | null>(null)
  const [canSteer, setCanSteer] = useState(agent === 'codex')
  const activeOptionRecordRef = useRef(optionState.record)
  const optionCatalog = useMemo(
    () => getAgentSessionOptionCatalog(agent === 'openclaude' ? 'claude' : agent),
    [agent]
  )
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: state.fence,
    submissions: state.submissions,
    isWorking: turnId !== null
  })

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent)
    activeOptionRecordRef.current = next.record
    setOptionState(next)
    optionSnapshotRef.current = []
    setProviderOptionSnapshot(undefined)
    pendingOptionRef.current = null
    setCanSteer(agent === 'codex')
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

  // Turns are what confirm an option: the provider names the model it is running
  // on the frame that opens each one, so re-read the options as a turn changes
  // rather than leaving the last write unconfirmed for the life of the session.
  const isMonitoringBackgroundTasks =
    turnId === null && state.backgroundTasks?.state === 'monitoring'

  useEffect(() => {
    if (!isVisible) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (!stale) {
          setCanSteer(result.canSteer === true)
          if (result.descriptors) {
            optionSnapshotRef.current = result.descriptors
            setProviderOptionSnapshot(result.descriptors)
          }
          if (optionCatalog) {
            setOptionState((current) =>
              current.record === activeOptionRecordRef.current
                ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
                : current
            )
          }
        }
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [isVisible, optionCatalog, sessionId, state.fence, target, turnId])

  const optionSnapshot = useMemo(() => {
    const next = providerOptionSnapshot ?? structuredAgentSessionOptionSnapshot(optionState)
    optionSnapshotRef.current = next
    return next
  }, [optionState, providerOptionSnapshot])
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const descriptor = optionSnapshotRef.current.find((entry) => entry.id === id)
      const valid =
        descriptor?.settable === true &&
        (descriptor.kind.type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'string' &&
            descriptor.kind.choices.some((choice) => choice.value === value))
      if (!valid || pendingOptionRef.current !== null) {
        return false
      }
      pendingOptionRef.current = id
      const targetRecord = optionState.record
      setOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const wireValue = String(value)
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: wireValue }
        )
        if (result && activeOptionRecordRef.current === targetRecord) {
          const values = result.options ?? { [id]: wireValue }
          const reported = await callStructuredAgentSession<AgentSessionOptionsResult>(
            target,
            'agentSession.options',
            { sessionId }
          ).catch(() => null)
          if (activeOptionRecordRef.current !== targetRecord) {
            return Boolean(result)
          }
          const next =
            reported?.descriptors ??
            patchStructuredAgentSessionOptionSnapshot(optionSnapshotRef.current, values)
          optionSnapshotRef.current = next
          setProviderOptionSnapshot(next)
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, values)
              : current
          )
        }
        return Boolean(result)
      } finally {
        pendingOptionRef.current = null
        setOptionState((current) =>
          current.record === targetRecord && current.pendingId === id
            ? { ...current, pendingId: null }
            : current
        )
      }
    },
    [mutate, optionState.record, target, sessionId]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      return { snapshot: optionSnapshotRef.current }
    },
    [setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshotRef.current,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshotRef.current }),
      subscribe: () => () => {}
    }),
    [setOption]
  )

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
    edit: outboxController.edit,
    remove: outboxController.remove,
    reorder: outboxController.reorder,
    steer: outboxController.steer,
    retry: outboxController.retry,
    canSteer,
    isWorking: turnId !== null,
    isMonitoringBackgroundTasks,
    backgroundTasks: state.backgroundTasks?.tasks ?? [],
    supportsBackgroundTaskStop: state.backgroundTasks?.supportsTaskStop === true,
    turnId,
    cancel: (turnId: string) => mutate('agentSession.cancel', 'agentSession.cancel', { turnId }),
    stopBackgroundTask: (taskId?: string) =>
      mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
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
