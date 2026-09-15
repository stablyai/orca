import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as conversationCommands from './structured-conversation-command-send'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
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
import {
  activeStructuredAgentSessionTurnId,
  hasUnansweredStructuredAgentSessionDispatch
} from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionPromptCancel
} from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { selectStructuredAgentTurnActivity } from '../../../../shared/native-chat-turn-activity'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
import { useStructuredAgentTurnTiming } from './use-structured-agent-turn-timing'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

type StructuredPromptCancelTarget = { itemId: string; expectedRevision: number }

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
}) {
  const { agent, isVisible, sessionId, target } = args
  // Declared first: the hold is what gives a restored session its provider child back, and the
  // read below is useless for sending until it lands.
  useStructuredAgentSessionHold({ sessionId, target, surface: 'desktop-chat', enabled: isVisible })
  const { state, loadingOlder, loadOlder } = useStructuredAgentSessionRead(args)
  const stateRef = useRef(state)
  const { mutate, writeError } = useStructuredAgentSessionMutate({ sessionId, target, stateRef })
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const commandPending = useRef(false)
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
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, sessionId, state.fence])

  // Refresh options each turn to confirm which model the provider actually selected.
  const turnId = activeStructuredAgentSessionTurnId(state.items)
  // A dispatch the provider has not answered is already work; Claude's running row trails the
  // send by seconds, and only a provider-minted turn is cancellable, so the two stay separate.
  const isWorking =
    turnId !== null || hasUnansweredStructuredAgentSessionDispatch(state.submissions, state.fence)
  const turnActivity = useMemo(
    () => selectStructuredAgentTurnActivity(state.items, turnId, state.activity),
    [state.activity, state.items, turnId]
  )
  const turnTiming = useStructuredAgentTurnTiming(state, turnId)
  const backgroundTasks = structuredSessionBackgroundTasksView(state.backgroundTasks, turnId)

  useEffect(() => {
    if (!isVisible || !optionCatalog) {
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
  }, [isVisible, optionCatalog, sessionId, state.fence, target, turnId, updateOptionState])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(optionState),
    [optionState]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
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
            void enqueueSessionOptionSettingsWrite(target, {
              type: 'apply-picks',
              agent,
              picks
            })
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
    [agent, mutate, optionCatalog, sessionId, target, updateOptionState]
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
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [optionSnapshot, setOption]
  )

  const prompts = pendingStructuredSessionPrompts(state.items)
  const { outbox } = outboxController
  const messages = useStructuredAgentSessionMessages(state.items, outbox, state.submissions)
  return {
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      conversationCommands.sendStructuredConversationCommand({
        command,
        pending: commandPending,
        blocked: Boolean(turnId || prompts.length || backgroundTasks.isMonitoring || outbox.length),
        send: (command) =>
          mutate<AgentSessionConversationCommandResult>(
            'agentSession.conversationCommand',
            'agentSession.conversationCommand',
            { command }
          )
      }),
    journalItems: state.items,
    messages,
    status: state.status,
    error: state.error ?? writeError ?? outboxController.error,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
    prompts,
    outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: (...input: Parameters<typeof outboxController.send>) =>
      !commandPending.current && outboxController.send(...input),
    retry: outboxController.retry,
    isWorking,
    workingStartedAt: turnTiming.workingStartedAt,
    settledTurns: turnTiming.settledTurns,
    turnActivity,
    backgroundTasks,
    turnId,
    cancel: async (turnId: string, prompt?: StructuredPromptCancelTarget) => {
      // Capability negotiation must complete before mutate constructs the payload
      // fingerprint and operation id: older hosts reject the strict prompt field.
      const promptSupported =
        prompt !== undefined && (await supportsStructuredAgentSessionPromptCancel(target))
      return mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId,
        ...(promptSupported ? { prompt } : {})
      })
    },
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
    sessionCommands: state.commands ?? undefined,
    setStructuredOption
  }
}
