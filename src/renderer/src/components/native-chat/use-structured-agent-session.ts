import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as conversationCommands from './structured-conversation-command-send'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import {
  useStructuredAgentSessionMutate,
  type StructuredAgentSessionMutate
} from './use-structured-agent-session-mutate'
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
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import {
  activeStructuredAgentSessionTurnId,
  hasUnansweredStructuredAgentSessionDispatch
} from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
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

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

/** The pane's whole view of a structured session; the notice strip reads it too. */
export type StructuredAgentSessionController = ReturnType<typeof useStructuredAgentSession>

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  ownerPairingRevision?: number
  ownerPairingStale?: boolean
  agent: AgentType
  isVisible: boolean
}) {
  const { agent, isVisible, ownerPairingStale = false, sessionId, target } = args
  // A re-paired owner leaves the transcript exactly as last read and stops every write: the id now
  // names a different machine, so re-reading or mutating would address a stranger's journal.
  const live = isVisible && !ownerPairingStale
  // Declared first: the hold is what gives a restored session its provider child back, and the
  // read below is useless for sending until it lands.
  useStructuredAgentSessionHold({ sessionId, target, surface: 'desktop-chat', enabled: live })
  const { state, loadingOlder, loadOlder } = useStructuredAgentSessionRead({
    ...args,
    isVisible: live
  })
  const stateRef = useRef(state)
  const { mutate: liveMutate, writeError } = useStructuredAgentSessionMutate({
    sessionId,
    target,
    stateRef
  })
  const cachedMutate = useCallback(async () => null, [])
  const mutate = ownerPairingStale ? (cachedMutate as StructuredAgentSessionMutate) : liveMutate
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const commandPending = useRef(false)
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
    if (!live || !optionCatalog) {
      return
    }
    let stale = false
    void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (!stale) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
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
  }, [live, optionCatalog, sessionId, state.fence, target, turnId])

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
          const committed = result.options ?? { [id]: value }
          setOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          const picks = structuredAgentSessionOptionPicks(optionState, committed)
          if (picks.length > 0) {
            void enqueueSessionOptionSettingsWrite(target, {
              type: 'apply-picks',
              agent,
              picks
            })
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
    [agent, mutate, optionState, target]
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

  const prompts = pendingStructuredSessionPrompts(state.items)
  const { outbox } = outboxController
  const messages = useStructuredAgentSessionMessages(state.items, outbox, state.submissions)
  return {
    /** Read-only view of the last transcript: this pane's owner is no longer the host on that id. */
    cached: ownerPairingStale,
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
      !ownerPairingStale && !commandPending.current && outboxController.send(...input),
    retry: outboxController.retry,
    isWorking,
    workingStartedAt: turnTiming.workingStartedAt,
    settledTurns: turnTiming.settledTurns,
    turnActivity,
    backgroundTasks,
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
    sessionCommands: state.commands ?? undefined,
    setStructuredOption
  }
}
