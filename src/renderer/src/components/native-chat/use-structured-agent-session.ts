import { useRef } from 'react'
import * as structuredConversationCommands from './structured-conversation-command-send'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { supportsStructuredAgentSessionPromptCancel } from '@/runtime/structured-agent-session-client'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'
import { useStructuredAgentSessionContextUsage } from './use-structured-agent-session-context-usage'
import { useStructuredAgentSessionRailOutline } from './use-structured-agent-session-rail-outline'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

type StructuredPromptCancelTarget = { itemId: string; expectedRevision: number }

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  transportEnabled?: boolean
}) {
  const { agent, isVisible, sessionId, target, transportEnabled = true } = args
  const { state, loadingOlder, loadOlder, mutate, writeError, providerVisible } =
    useStructuredAgentSessionTransport({
      sessionId,
      target,
      isVisible,
      enabled: transportEnabled
    })
  const commandPending = useRef(false)
  const transportState = useStructuredAgentSessionTransportState(state, transportEnabled)
  const {
    conversationCommands,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    threadGoal: threadGoalSupport,
    contextUsage: contextUsageSupport
  } = useStructuredAgentSessionOptions({
    agent,
    sessionId,
    target,
    transportEnabled,
    providerVisible,
    fence: state.fence,
    turnId: transportState.turnId,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    mutate
  })
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: transportState.fence,
    submissions: transportState.submissions
  })

  const threadGoal = useStructuredAgentSessionThreadGoal({
    journalItems: transportState.journalItems,
    support: threadGoalSupport,
    mutate
  })
  const contextUsage = useStructuredAgentSessionContextUsage(
    transportState.journalItems,
    contextUsageSupport
  )

  const railOutline = useStructuredAgentSessionRailOutline({
    sessionId,
    target,
    state,
    enabled: providerVisible
  })

  const prompts = pendingStructuredSessionPrompts(transportState.journalItems)
  const { outbox } = outboxController
  const messages = useStructuredAgentSessionMessages(
    transportState.journalItems,
    outbox,
    transportState.submissions
  )
  return {
    conversationCommands,
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      structuredConversationCommands.sendStructuredConversationCommand({
        command,
        pending: commandPending,
        blocked: Boolean(
          transportState.turnId ||
          prompts.length ||
          transportState.backgroundTasks.isMonitoring ||
          outbox.length
        ),
        send: (command) =>
          mutate<AgentSessionConversationCommandResult>(
            'agentSession.conversationCommand',
            'agentSession.conversationCommand',
            { command }
          )
      }),
    journalItems: transportState.journalItems,
    messages,
    status: transportEnabled ? state.status : 'ready',
    error: transportEnabled
      ? (state.error ?? writeError ?? outboxController.error)
      : outboxController.error,
    hasOlder: transportEnabled && state.hasOlder,
    railOutline: transportEnabled ? railOutline : null,
    loadingOlder: transportEnabled && loadingOlder,
    loadOlder,
    prompts,
    outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: (...input: Parameters<typeof outboxController.send>) =>
      !commandPending.current && outboxController.send(...input),
    retry: outboxController.retry,
    isWorking: transportState.isWorking,
    workingStartedAt: transportState.turnTiming.workingStartedAt,
    settledTurns: transportState.turnTiming.settledTurns,
    turnActivity: transportState.turnActivity,
    backgroundTasks: transportState.backgroundTasks,
    turnId: transportState.turnId,
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
    sessionCommands: transportEnabled ? (state.commands ?? undefined) : undefined,
    setStructuredOption,
    threadGoal,
    contextUsage
  }
}
