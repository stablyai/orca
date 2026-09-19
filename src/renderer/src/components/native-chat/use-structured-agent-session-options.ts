import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

export function useStructuredAgentSessionOptions(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  providerVisible: boolean
  fence: number | null
  turnId: string | null
  mutate: StructuredAgentSessionMutate
}) {
  const { agent, fence, mutate, providerVisible, sessionId, target, transportEnabled, turnId } =
    args
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const optionCatalog = useMemo(() => getAgentSessionOptionCatalog(agent), [agent])

  useEffect(() => {
    const next = createStructuredAgentSessionOptionState(agent)
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, fence, sessionId, transportEnabled])

  // Refresh options each turn to confirm which model the provider actually selected.
  useEffect(() => {
    if (!providerVisible || !optionCatalog) {
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (!stale && optionMutationGeneration.current === readGeneration) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
          updateOptionState((current) =>
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
  }, [fence, optionCatalog, providerVisible, sessionId, target, turnId, updateOptionState])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )
  const visibleOptionSnapshot = useMemo(
    () => (transportEnabled ? optionSnapshot : []),
    [optionSnapshot, transportEnabled]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        !transportEnabled ||
        pendingOptionRef.current !== null ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(currentState, id, value)
      ) {
        return false
      }
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (
          result &&
          activeOptionRecordRef.current === targetRecord &&
          optionMutationGeneration.current === mutationGeneration
        ) {
          const committed = result.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          const picks = structuredAgentSessionOptionPicks(currentState, committed)
          if (picks.length > 0) {
            void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
          }
          if (!transportEnabled) {
            return false
          }
          void callStructuredAgentSession<AgentSessionOptionsResult>(
            target,
            'agentSession.options',
            { sessionId }
          )
            .then((refreshed) => {
              if (
                activeOptionRecordRef.current === targetRecord &&
                optionMutationGeneration.current === mutationGeneration
              ) {
                updateOptionState((latest) =>
                  latest.record === targetRecord
                    ? applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                    : latest
                )
              }
            })
            .catch(() => {})
        }
        return Boolean(result)
      } finally {
        if (
          activeOptionRecordRef.current === targetRecord &&
          optionMutationGeneration.current === mutationGeneration
        ) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [agent, mutate, optionCatalog, sessionId, target, transportEnabled, updateOptionState]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      return { snapshot: structuredAgentSessionOptionSnapshot(optionStateRef.current) }
    },
    [setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => visibleOptionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: visibleOptionSnapshot }),
      subscribe: () => () => {}
    }),
    [setOption, visibleOptionSnapshot]
  )

  return {
    conversationCommands:
      transportEnabled && conversationSupport?.sessionId === sessionId
        ? conversationSupport.commands
        : [],
    optionSnapshot: visibleOptionSnapshot,
    optionSurface,
    setStructuredOption
  }
}
