import { useMemo, useRef } from 'react'
import * as structuredConversationCommands from './structured-conversation-command-send'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import {
  supportsStructuredAgentSessionPromptCancel,
  supportsStructuredAgentSessionQuestionAnswers
} from '@/runtime/structured-agent-session-client'
import {
  useStructuredAgentSessionHostQueuesMessagesState,
  useStructuredAgentSessionHostStopsConversation
} from '@/runtime/structured-agent-session-host-capability'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import {
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse
} from '../../../../shared/agent-session-question-answer'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'
import { useStructuredAgentSessionContextUsage } from './use-structured-agent-session-context-usage'
import { useStructuredAgentSessionRailOutline } from './use-structured-agent-session-rail-outline'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { outboxOutsideQueuedCards } from './structured-agent-session-queued-cards'
import { structuredAgentSessionStartFailureFacts } from './structured-agent-session-delivery-notices'
import { hostStatesTurnScopes } from '../../../../shared/native-chat-turn-membership'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import { withNativeChatCutTurnNotices } from '../../../../shared/native-chat-cut-turn-notice'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

type StructuredPromptCancelTarget = { itemId: string; expectedRevision: number }

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  transportEnabled?: boolean
  /** The host has published the session but its provider has not answered startup yet. */
  providerStarting?: boolean
  /** This view started the session; only then does the stored selection name what it runs. */
  launch?: StructuredAgentSessionLaunchView
  /** The composer Edit copies a card's text into, and that gets back unsent outbox text. */
  composerScopeKey?: string
  /** The chat-wide "queue follow-ups" setting; off keeps mid-turn sends immediate. */
  queueFollowUps?: boolean
}) {
  const {
    agent,
    composerScopeKey,
    isVisible,
    launch,
    providerStarting = false,
    queueFollowUps = true,
    sessionId,
    target,
    transportEnabled = true
  } = args
  const {
    state,
    stateRef,
    loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    mutate,
    write,
    providerVisible
  } = useStructuredAgentSessionTransport({
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
    isVisible,
    providerVisible,
    providerStarting,
    fence: state.fence,
    turnId: transportState.turnId,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    mutate,
    ...(launch ? { launch } : {})
  })
  // Only a capable host may see `delivery` or the queuedMessage RPCs; against
  // anything older this client must look exactly like today's.
  const queueCapability = useStructuredAgentSessionHostQueuesMessagesState(target)
  const queueCapable = queueCapability === 'supported'
  const queuedMessageIds = useMemo(
    () => (transportState.queuedMessages ?? []).map((message) => message.messageId),
    [transportState.queuedMessages]
  )
  const prompts = pendingStructuredSessionPrompts(transportState.journalItems)
  // A host's queue waits on any pending prompt, and nothing here can settle one this build cannot
  // answer: the send must start a turn, after which the card's cancel works.
  const queueEnabled = queueFollowUps && !pendingPromptsAllUnanswerableHere(prompts)
  const queueDelivery = useMemo(
    () => ({ capability: queueCapability, enabled: queueEnabled }),
    [queueCapability, queueEnabled]
  )
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: transportState.fence,
    submissions: transportState.submissions,
    journalItems: transportState.journalItems,
    composerScopeKey,
    queueDelivery,
    queuedMessageIds
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

  const { outbox } = outboxController
  // A host that takes a Stop naming no turn gets Stop from the send until the work settles; every
  // Stop before a turn opens needs that form. An older host can stop only a turn it has opened.
  const stopsConversation =
    useStructuredAgentSessionHostStopsConversation(target) && transportState.fence !== null
  const canStop =
    transportState.turnId !== null ||
    (stopsConversation &&
      (transportState.isWorking ||
        hasUnsentStructuredAgentSessionOutboxEntry(outbox, transportState.submissions)))
  // A queued send is a card, never a transcript bubble.
  const isWorking = transportState.isWorking
  const transcriptOutbox = useMemo(
    () => outboxOutsideQueuedCards(outbox, queuedMessageIds, isWorking, queueDelivery),
    [isWorking, outbox, queueDelivery, queuedMessageIds]
  )
  // What the transcript reads: the journal plus the one notice a cut turn with no row gets.
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(transportState.journalItems, {
        agentName: TUI_AGENT_DISPLAY_NAMES[agent === 'codex' ? 'codex' : 'claude']
      }),
    [agent, transportState.journalItems]
  )
  const messages = useStructuredAgentSessionMessages(
    transcriptItems,
    transcriptOutbox,
    transportState.submissions,
    queuedMessageIds
  )
  const queuedController = useStructuredAgentSessionQueuedMessages({
    enabled: queueCapable && transportState.fence !== null,
    queuedMessages: transportState.queuedMessages,
    queuePause: transportState.queuePause,
    submissions: transportState.submissions,
    hasPendingPrompt: prompts.length > 0,
    composerScopeKey,
    mutate
  })
  return {
    conversationCommands,
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      structuredConversationCommands.sendStructuredConversationCommand({
        command,
        agentName: structuredAgentLabel(agent === 'codex' ? 'codex' : 'claude'),
        pending: commandPending,
        blocked: Boolean(
          transportState.turnId ||
          prompts.length ||
          transportState.backgroundTasks.isMonitoring ||
          outbox.length
        ),
        startFailures: () => structuredAgentSessionStartFailureFacts(stateRef.current.items),
        send: (command) =>
          write<AgentSessionConversationCommandResult>(
            'agentSession.conversationCommand',
            'agentSession.conversationCommand',
            { command }
          )
      }),
    journalItems: transcriptItems,
    subagentRoster: transportState.subagentRoster,
    messages,
    status: transportEnabled ? state.status : 'ready',
    /** The outbox's own line; a failed read is worded from `readRefusal`, never its text. */
    error: outboxController.error,
    /** The refusal the failed read met, while `status` is `error`. */
    readRefusal: transportEnabled ? state.readRefusal : undefined,
    hasOlder: transportEnabled && state.hasOlder,
    railOutline: transportEnabled ? railOutline : null,
    loadingOlder: transportEnabled && loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    prompts,
    outbox,
    failedHere: outboxController.failedHere,
    /** The journal's rows for sent messages, which carry a rejected message's whole fact. */
    submissions: transportState.submissions,
    /** The host's queued cards, which hold their own rejected hand-offs. */
    queuedMessageIds,
    // A message typed during a command queues behind it on the host.
    send: (...input: Parameters<typeof outboxController.send>) =>
      // Legacy: an older host refuses sends while a command runs; removable once those hosts age out.
      (!commandPending.current || hostStatesTurnScopes(transportState.journalItems)) &&
      outboxController.send(...input),
    retry: outboxController.retry,
    isWorking: transportState.isWorking,
    workingStartedAt: transportState.turnTiming.workingStartedAt,
    settledTurns: transportState.turnTiming.settledTurns,
    turnActivity: transportState.turnActivity,
    backgroundTasks: transportState.backgroundTasks,
    turnId: transportState.turnId,
    canStop,
    stop: () => {
      if (stopsConversation) {
        // Unsent text this client still owns goes back to its composer — a local move.
        // Host-held drafts are never withdrawn by a Stop: the host pauses them and
        // they stay visible as cards, on every device, until the user acts on one.
        outboxController.withdrawUnsent()
        return mutate('agentSession.cancel', 'agentSession.cancel', {})
      }
      return transportState.turnId
        ? mutate('agentSession.cancel', 'agentSession.cancel', { turnId: transportState.turnId })
        : Promise.resolve(null)
    },
    queuedMessages: queuedController,
    cancel: async (turnId: string, prompt?: StructuredPromptCancelTarget) => {
      // Capability negotiation must complete before mutate fingerprints the payload:
      // older hosts reject the strict prompt field.
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
    respond: async (item: StructuredPromptItem, response: AgentSessionPromptResponse) => {
      const promptTarget = { itemId: item.itemId, expectedRevision: item.revision }
      let fields: Record<string, unknown>
      if (response.kind === 'option') {
        fields = { ...promptTarget, optionId: response.optionId }
      } else if (await supportsStructuredAgentSessionQuestionAnswers(target)) {
        // Negotiated before mutate fingerprints the call: older hosts reject the strict field.
        fields = { ...promptTarget, answers: response.answers }
      } else {
        const optionId =
          item.body.kind === 'question'
            ? legacyAgentSessionSelectedOptionId(item.body, response.answers)
            : null
        if (optionId === null) {
          return null
        }
        fields = { ...promptTarget, optionId }
      }
      return mutate<AgentSessionPromptResult>(
        item.body.kind === 'approval'
          ? 'agentSession.respondToApproval'
          : 'agentSession.respondToQuestion',
        `agentSession.respondTo:${item.body.kind}`,
        fields
      )
    },
    optionSnapshot,
    optionSurface,
    sessionCommands: transportEnabled ? (state.commands ?? undefined) : undefined,
    setStructuredOption,
    threadGoal,
    contextUsage
  }
}
