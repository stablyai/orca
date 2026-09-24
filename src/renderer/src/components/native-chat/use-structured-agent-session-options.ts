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
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

export function useStructuredAgentSessionOptions(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  providerVisible: boolean
  fence: number | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
  mutate: StructuredAgentSessionMutate
}) {
  const { agent, fence, mutate, providerVisible, sessionId, target, transportEnabled, turnId } =
    args
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    threadGoal: AgentSessionOptionsResult['threadGoal']
    contextUsage: AgentSessionOptionsResult['contextUsage']
  } | null>(null)
  // A revision the loaded window dropped can move the host's whole-journal context facts.
  const contextRefresh = conversationSupport?.contextUsage ? (args.unloadedTurnRevisions ?? 0) : 0
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

  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // Refresh options each turn to confirm which model the provider actually selected.
  useEffect(() => {
    if (!providerVisible || !optionCatalog) {
      return
    }
    let stale = false
    const runner = createCoalescedPollRunner(async () => {
      const readGeneration = optionMutationGeneration.current
      const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
        target,
        'agentSession.options',
        { sessionId }
      )
      if (!stale && optionMutationGeneration.current === readGeneration) {
        setConversationSupport({
          sessionId,
          commands: result.conversationCommands ?? [],
          threadGoal: result.threadGoal,
          contextUsage: result.contextUsage
        })
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? applyStructuredAgentSessionOptions(current, optionCatalog, result)
            : current
        )
      }
    })
    optionsReadRef.current = runner
    runner.run()
    return () => {
      stale = true
      runner.dispose()
    }
  }, [fence, optionCatalog, providerVisible, sessionId, target, turnId, updateOptionState])

  // Reads share the session's host queue with sends and interrupts, so a burst of
  // missed revisions keeps one read in flight and at most one behind it.
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      optionsReadRef.current?.run()
    }
  }, [contextRefresh])

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
    /** Absent unless this host and session can change the goal. */
    threadGoal:
      transportEnabled && conversationSupport?.sessionId === sessionId
        ? conversationSupport.threadGoal
        : undefined,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage:
      transportEnabled && conversationSupport?.sessionId === sessionId
        ? conversationSupport.contextUsage
        : undefined,
    optionSnapshot: visibleOptionSnapshot,
    optionSurface,
    setStructuredOption
  }
}
