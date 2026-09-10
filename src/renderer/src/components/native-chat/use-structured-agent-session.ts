import { useStructuredAgentSessionStatusSummary } from './use-structured-agent-session-status-summary'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useNativeChatRewind } from './use-native-chat-rewind'
import type {
  AgentSessionRewindResult,
  AgentSessionRewindSupport
} from '../../../../shared/agent-session-rewind'
import * as conversationCommands from './structured-conversation-command-send'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session-wire'
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
import { activeStructuredAgentSessionTurnId } from '../../../../shared/structured-agent-session-projection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredAgentSessionHold } from './use-structured-agent-session-hold'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { selectStructuredAgentTurnActivity } from './native-chat-turn-activity'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
}) {
  const { agent, isVisible, sessionId, target } = args
  const summary = useStructuredAgentSessionStatusSummary(sessionId, target)
  // Declared first: the hold is what gives a restored session its provider child back, and the
  // read below is useless for sending until it lands.
  useStructuredAgentSessionHold({ sessionId, target, surface: 'desktop-chat', enabled: isVisible })
  const { state, loadingOlder, loadOlder } = useStructuredAgentSessionRead(args)
  const stateRef = useRef(state)
  const { mutate, writeError } = useStructuredAgentSessionMutate({ sessionId, target, stateRef })
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    rewind?: AgentSessionRewindSupport
    fence: number | null
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
    fence: summary?.rewindBlockedReason ? null : state.fence,
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
  const turnActivity = useMemo(
    () => selectStructuredAgentTurnActivity(state.items, turnId, state.activity),
    [state.activity, state.items, turnId]
  )
  const backgroundTasksView = structuredSessionBackgroundTasksView(state.backgroundTasks, turnId)
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
          setConversationSupport({
            sessionId,
            commands: result.conversationCommands ?? [],
            rewind: result.rewind,
            fence: state.fence
          })
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
  const rewindSupportResolved =
    conversationSupport?.sessionId === sessionId && conversationSupport.fence === state.fence
  const rewindSupport = rewindSupportResolved ? conversationSupport.rewind : undefined
  const rewindBlocked = Boolean(
    turnId ||
    prompts.length ||
    isMonitoringBackgroundTasks ||
    outboxController.outbox.length ||
    commandPending.current
  )
  const rewindInput = useMemo<Parameters<typeof useNativeChatRewind>[0]>(
    () => ({
      sessionId,
      hostBlockedReason: summary?.rewindBlockedReason,
      state,
      support: rewindSupport,
      supportResolved: rewindSupportResolved,
      blocked: rewindBlocked,
      send: (fields, onFailure) =>
        mutate<AgentSessionRewindResult>(
          'agentSession.rewind',
          'agentSession.rewind',
          fields,
          undefined,
          onFailure
        )
    }),
    [
      sessionId,
      summary?.rewindBlockedReason,
      state,
      rewindSupport,
      rewindSupportResolved,
      rewindBlocked,
      mutate
    ]
  )
  const rewind = useNativeChatRewind(rewindInput)
  const { outbox } = outboxController
  const messages = useStructuredAgentSessionMessages(state.items, outbox, state.submissions)
  return {
    epoch: state.epoch,
    rewind,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      conversationCommands.sendStructuredConversationCommand({
        command,
        pending: commandPending,
        blocked: Boolean(
          turnId ||
          prompts.length ||
          isMonitoringBackgroundTasks ||
          outbox.length ||
          rewind.blockedRef.current
        ),
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
    error: rewind.error ?? state.error ?? writeError ?? outboxController.error,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
    prompts,
    outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: (...input: Parameters<typeof outboxController.send>) =>
      !commandPending.current && !rewind.blockedRef.current && outboxController.send(...input),
    retry: (clientMessageId: string) => {
      if (!rewind.blockedRef.current) {
        outboxController.retry(clientMessageId)
      }
    },
    isWorking: turnId !== null,
    turnActivity,
    isMonitoringBackgroundTasks,
    backgroundTasks: state.backgroundTasks?.tasks ?? [],
    supportsBackgroundTaskStop: state.backgroundTasks?.supportsTaskStop === true,
    backgroundTasksView,
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
