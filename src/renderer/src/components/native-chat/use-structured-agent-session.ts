import { useMemo, useRef } from 'react'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { useStructuredAgentSessionCommandWrite } from './use-structured-agent-session-command-write'
import { structuredAgentSessionNewSendsQueue } from './structured-agent-session-queue-request'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useStructuredLegacyLaunchStop } from '@/lib/structured-agent-session-legacy-launch-stop'
import { supportsStructuredAgentSessionPromptCancel } from '@/runtime/structured-agent-session-client'
import {
  useStructuredAgentSessionHostQueuesCommands,
  useStructuredAgentSessionHostQueuesMessagesState
} from '@/runtime/structured-agent-session-host-capability'
import { structuredAgentSessionStopControl } from './structured-agent-session-stop-control'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session-question-answer'
import { respondToStructuredAgentSessionPrompt } from './structured-agent-session-prompt-response'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { useStructuredAgentSessionStop } from './use-structured-agent-session-stop'
import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'
import { useStructuredAgentSessionContextUsage } from './use-structured-agent-session-context-usage'
import { useStructuredAgentSessionRailOutline } from './use-structured-agent-session-rail-outline'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { structuredConversationCommandRunner } from './structured-conversation-command-send'
import {
  commandCardWaiting,
  pendingSendsOutsideQueuedCards
} from './structured-agent-session-queued-cards'
import { hostStatesTurnScopes } from '../../../../shared/native-chat-turn-membership'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import { withNativeChatCutTurnNotices } from '../../../../shared/native-chat-cut-turn-notice'
import { useStructuredAgentSessionRewind } from './use-structured-agent-session-rewind'
import type { NativeChatRewindHost } from './use-native-chat-rewind'

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
  /** The host runs the session's provider, started or not. */
  providerRunning?: boolean
  /** This view started the session; only then does the stored selection name what it runs. */
  launch?: StructuredAgentSessionLaunchView
  /** The composer Edit copies a card's text into. */
  composerScopeKey?: string
  /** The chat-wide "queue follow-ups" setting; off keeps mid-turn sends immediate. */
  queueFollowUps?: boolean
  /** The host says a person's Stop is still ending this session's work. */
  hostStopping?: boolean
  /** The host's rewind latch and what follows a message returned by a rewind. */
  rewind?: NativeChatRewindHost
}) {
  const {
    agent,
    composerScopeKey,
    hostStopping = false,
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
  const legacyLaunchStop = useStructuredLegacyLaunchStop(sessionId)
  const transportState = useStructuredAgentSessionTransportState(state, transportEnabled)
  const {
    conversationCommands,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    unavailable,
    threadGoal: threadGoalSupport,
    contextUsage: contextUsageSupport,
    rewind: rewindSupport
  } = useStructuredAgentSessionOptions({
    agent,
    sessionId,
    target,
    transportEnabled,
    isVisible,
    providerVisible,
    providerStarting,
    ...(args.providerRunning ? { providerRunning: true } : {}),
    fence: state.fence,
    turnId: transportState.turnId,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    mutate,
    ...(launch ? { launch } : {})
  })
  // Only a capable host may see `delivery`; a card any host publishes shows, with its actions.
  const queueCapability = useStructuredAgentSessionHostQueuesMessagesState(target)
  const queuedMessageIds = useMemo(
    () => (transportState.queuedMessages ?? []).map((message) => message.messageId),
    [transportState.queuedMessages]
  )
  const stopControl = useStructuredAgentSessionStop({
    sessionId,
    target,
    transportState,
    hostStopping,
    mutate
  })
  const prompts = pendingStructuredSessionPrompts(transportState.journalItems)
  const promptsUnanswerableHere = pendingPromptsAllUnanswerableHere(prompts)
  // A send after a command the queue will run goes behind it, even with follow-ups off.
  // A host's queue waits on any pending prompt, and nothing here can settle one this build cannot
  // answer: the send must start a turn, after which the card's cancel works.
  const commandWaiting = commandCardWaiting(transportState.queuedMessages)
  const queueEnabled = (queueFollowUps || commandWaiting) && !promptsUnanswerableHere
  const queue = useMemo(
    () => ({ capability: queueCapability, enabled: queueEnabled }),
    [queueCapability, queueEnabled]
  )
  const sends = useStructuredAgentSessionSends({
    sessionId,
    target,
    // Never held for an in-doubt rewind: the host recovers it on the next send.
    fence: transportState.fence,
    submissions: transportState.submissions,
    queuedMessageIds,
    queue,
    historyLoaded: transportEnabled && state.status === 'ready',
    isWorking: transportState.isWorking,
    stopping: stopControl.stopping
  })

  const threadGoal = useStructuredAgentSessionThreadGoal({
    journalItems: transportState.journalItems,
    journalEpoch: state.epoch,
    support: threadGoalSupport,
    mutate
  })
  const contextUsage = useStructuredAgentSessionContextUsage(
    transportState.journalItems,
    contextUsageSupport,
    state.epoch
  )

  const railOutline = useStructuredAgentSessionRailOutline({
    sessionId,
    target,
    state,
    enabled: providerVisible
  })

  const { pending } = sends
  const commandWrite = useStructuredAgentSessionCommandWrite(sessionId, write)
  const sending = pending.some((entry) => entry.phase === 'sending')
  // What the host refuses a rewind behind; a command's own hold is the runner's below.
  const conversationBusy = transportState.conversationBusy || prompts.length > 0 || sending
  const rewind = useStructuredAgentSessionRewind({
    sessionId,
    target,
    composerScopeKey,
    ...args.rewind,
    state,
    support: transportEnabled ? rewindSupport : undefined,
    contextFloor: contextUsageSupport?.contextFloor ?? threadGoalSupport?.contextFloor,
    // The host also refuses a rewind behind its queued cards, paused ones included.
    blocked: conversationBusy || commandPending.current || queuedMessageIds.length > 0,
    write
  })
  // A queued send is a card, never a transcript bubble.
  const isWorking = transportState.isWorking || transportState.queueSendsNext
  const transcriptPending = useMemo(
    () => pendingSendsOutsideQueuedCards(pending, queuedMessageIds, isWorking),
    [isWorking, pending, queuedMessageIds]
  )
  // What the transcript reads: the journal plus the one notice a cut turn with no row gets.
  const transcriptItems = useMemo(
    () =>
      withNativeChatCutTurnNotices(transportState.journalItems, {
        agentName: structuredAgentLabel(agent)
      }),
    [agent, transportState.journalItems]
  )
  const messages = useStructuredAgentSessionMessages(
    transcriptItems,
    transcriptPending,
    transportState.submissions
  )
  const queuedController = useStructuredAgentSessionQueuedMessages({
    // Its published list, pause and submissions; the rest is named below.
    ...transportState,
    enabled: queueCapability === 'supported' && transportState.fence !== null,
    hasPendingPrompt: prompts.length > 0,
    isWorking,
    // Hidden from the transcript, a queue send on its way reads as sending among the cards.
    sending: pending,
    composerScopeKey,
    mutate
  })
  return {
    epoch: state.epoch,
    rewind,
    conversationCommands,
    ...structuredConversationCommandRunner({
      agentName: structuredAgentLabel(agent),
      pending: commandPending,
      // A /compact waits in line only where its card renders.
      commandsWait:
        useStructuredAgentSessionHostQueuesCommands(target) && queueCapability === 'supported',
      chat: transportState,
      prompts,
      rewindInFlight: rewind.blockedRef,
      sends: pending,
      items: () => stateRef.current.items,
      send: commandWrite
    }),
    journalItems: transcriptItems,
    /** The host's newest turn record, which places a live turn whose record is not loaded. */
    latestTurn: transportState.latestTurn,
    subagentRoster: transportState.subagentRoster,
    messages,
    status: transportEnabled ? state.status : 'ready',
    /** Why the last message came back to the composer; a failed read is worded from
     *  `readRefusal`, never its text. */
    error: sends.error,
    /** The refusal the failed read met, while `status` is `error`. */
    readRefusal: transportEnabled ? state.readRefusal : undefined,
    hasOlder: transportEnabled && state.hasOlder,
    railOutline: transportEnabled ? railOutline : null,
    loadingOlder: transportEnabled && loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    prompts,
    pending,
    /** A send is out, or a /clear holds sends; the chat takes none until it settles. */
    sendOut: sending || sends.held,
    /** The journal's rows for sent messages, which carry a rejected message's whole fact. */
    submissions: transportState.submissions,
    // A message typed during a command queues behind it on the host.
    send: (...input: Parameters<typeof sends.send>) =>
      // Legacy: an older host refuses sends while a command runs; removable once those hosts age out.
      (!commandPending.current || hostStatesTurnScopes(transportState.journalItems)) &&
      rewind.admitsSend() &&
      sends.send(...input),
    isWorking,
    queueSendsNext: transportState.queueSendsNext,
    workingStartedAt: transportState.turnTiming.workingStartedAt,
    settledTurns: transportState.turnTiming.settledTurns,
    turnActivity: transportState.turnActivity,
    backgroundTasks: transportState.backgroundTasks,
    turnId: transportState.turnId,
    ...structuredAgentSessionStopControl({
      published: transportEnabled,
      ...legacyLaunchStop,
      host: stopControl,
      transportState,
      sends: {
        sending,
        stopSends: sends.stopSends
      }
    }),
    stopPressed: stopControl.pressed,
    queuedMessages: queuedController,
    /** A send made now while the agent works is held as a queued card: the host queues, and this
     *  send asks it to (the setting is on and no pending prompt blocks the queue). */
    sendsQueue: structuredAgentSessionNewSendsQueue(queue),
    cancel: async (turnId: string | undefined, prompt?: StructuredPromptCancelTarget) => {
      // Capability negotiation must complete before mutate fingerprints the payload:
      // older hosts reject the strict prompt field.
      const promptSupported =
        prompt !== undefined && (await supportsStructuredAgentSessionPromptCancel(target))
      return mutate('agentSession.cancel', 'agentSession.cancel', {
        ...(turnId ? { turnId } : {}),
        ...(promptSupported ? { prompt } : {})
      })
    },
    stopBackgroundTask: (taskId?: string) =>
      mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    respond: (item: StructuredPromptItem, response: AgentSessionPromptResponse) =>
      respondToStructuredAgentSessionPrompt({ item, response, target, mutate }),
    optionSnapshot,
    optionSurface,
    sessionCommands: transportEnabled ? (state.commands ?? undefined) : undefined,
    setStructuredOption,
    /** Why the host's catalog probe says no chat can start here; the chat shows it as a notice. */
    unavailable,
    threadGoal,
    contextUsage
  }
}
