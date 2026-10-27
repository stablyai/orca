import { refreshStructuredAgentSessionCommands } from './structured-agent-session-command-refresh'
import { useMemo, useRef } from 'react'
import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { useStructuredAgentSessionCommandWrite } from './use-structured-agent-session-command-write'
import { structuredAgentSessionNewSendsQueue } from './structured-agent-session-queue-request'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionCancelResult } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useStructuredLegacyLaunchStop } from '@/lib/structured-agent-session-legacy-launch-stop'
import {
  useStructuredAgentSessionHostQueuesCommands,
  useStructuredAgentSessionHostEditsQueuedMessages,
  useStructuredAgentSessionHostEditsQueuedImages,
  useStructuredAgentSessionHostQueuesMessagesState
} from '@/runtime/structured-agent-session-host-capability'
import { structuredAgentSessionStopControl } from './structured-agent-session-stop-control'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session-question-answer'
import {
  respondToStructuredAgentSessionPrompt,
  cancelStructuredAgentSessionPrompt
} from './structured-agent-session-prompt-response'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from '../../../../shared/structured-agent-session-message-projection'
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
import { useNativeChatContextClearFloor } from './use-native-chat-context-clear-floor'
import { useStructuredAgentSessionRewind } from './use-structured-agent-session-rewind'
import type { NativeChatRewindHost } from './use-native-chat-rewind'

export type { StructuredPromptItem } from '../../../../shared/structured-agent-session-message-projection'

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  transportEnabled?: boolean
  /** The host has published the session but its provider has not answered startup yet. */
  providerStarting?: boolean
  /** The host runs the session's provider and its start is proven. */
  providerRunning?: boolean
  /** This view started the session; only then does the stored selection name what it runs. */
  launch?: StructuredAgentSessionLaunchView
  /** Composer destination for preserved text from queued-card edits. */
  composerScopeKey?: string
  /** The chat-wide "queue follow-ups" setting; off keeps mid-turn sends immediate. */
  queueFollowUps?: boolean
  /** The host says a person's Stop is still ending this session's work. */
  hostStopping?: boolean
  /** The option values the host's status carries; a change re-reads the chat's options. */
  hostOptionStamp?: string
  /** The host's rewind latch and what follows a message returned by a rewind. */
  rewind?: NativeChatRewindHost
}) {
  const {
    agent,
    hostStopping = false,
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
    readCurrent,
    loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    mutate,
    write,
    admit,
    capturePresentation,
    providerVisible
  } = useStructuredAgentSessionTransport({
    sessionId,
    target,
    isVisible: args.isVisible,
    enabled: transportEnabled,
    agentName: structuredAgentLabel(agent)
  })
  const commandPending = useRef(false)
  const legacyLaunchStop = useStructuredLegacyLaunchStop(sessionId)
  const transportState = useStructuredAgentSessionTransportState(state, transportEnabled)
  const journalItems = transportState.journalItems
  const {
    conversationCommands,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    sendSource,
    unavailable,
    threadGoal: threadGoalSupport,
    reportedThreadGoal,
    contextUsage: usageSupport,
    rewind: rewindSupport,
    acceptsImages
  } = useStructuredAgentSessionOptions({
    agent,
    sessionId,
    target,
    transportEnabled,
    isVisible: args.isVisible,
    providerVisible,
    providerStarting,
    ...(args.providerRunning ? { providerRunning: true } : {}),
    ...(args.hostOptionStamp ? { hostOptionStamp: args.hostOptionStamp } : {}),
    fence: state.fence,
    turnId: transportState.turnId,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    mutate,
    ...(launch ? { launch } : {})
  })
  const sendOptions = useStructuredAgentSessionSendOptions(sessionId, launch, sendSource)
  // Only a capable host may see `delivery`; a card any host publishes shows, with its actions.
  const queueCapability = useStructuredAgentSessionHostQueuesMessagesState(target)
  const queuedMessageIds = useMemo(
    () => (transportState.queuedMessages ?? []).map((message) => message.messageId),
    [transportState.queuedMessages]
  )
  const stopControlInput = { sessionId, target, transportState, hostStopping, mutate }
  const stopControl = useStructuredAgentSessionStop(stopControlInput)
  const prompts = pendingStructuredSessionPrompts(transportState)
  const promptsUnanswerableHere = pendingPromptsAllUnanswerableHere(prompts)
  // Queue after waiting commands even with follow-ups off, unless unanswerable prompts would strand the queue; immediate sends enable prompt cancellation.
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
    cursor: state.cursor,
    submissions: transportState.submissions,
    queuedMessageIds,
    queue,
    historyLoaded: transportEnabled && state.status === 'ready',
    isWorking: transportState.isWorking,
    stopping: stopControl.stopping,
    sendOptions
  })

  const usage = useStructuredAgentSessionContextUsage(journalItems, usageSupport, state.epoch)

  const contextFloor = usageSupport?.contextFloor ?? threadGoalSupport?.contextFloor
  const railOutline = useStructuredAgentSessionRailOutline({
    sessionId,
    target,
    state,
    contextFloor,
    enabled: providerVisible
  })

  const { pending } = sends
  const commandWrite = useStructuredAgentSessionCommandWrite(sessionId, write)
  const agentName = structuredAgentLabel(agent)
  const sending = pending.some((entry) => entry.phase === 'sending')
  // What the host refuses a rewind behind; a command's own hold is the runner's below.
  const conversationBusy = transportState.conversationBusy || prompts.length > 0 || sending
  const rewind = useStructuredAgentSessionRewind({
    sessionId,
    target,
    composerScopeKey: args.composerScopeKey,
    ...args.rewind,
    state,
    support: transportEnabled ? rewindSupport : undefined,
    contextFloor,
    // The host also refuses a rewind behind its queued cards, paused ones included.
    blocked: conversationBusy || commandPending.current || queuedMessageIds.length > 0,
    write,
    capturePresentation
  })
  const isWorking = transportState.isWorking || transportState.queueSendsNext
  const send = (...input: Parameters<typeof sends.send>) =>
    // Legacy: an older host refuses sends while a command runs; removable once those hosts age out.
    (!commandPending.current || hostStatesTurnScopes(journalItems)) &&
    rewind.admitsSend() &&
    sends.send(...input)
  const threadGoal = useStructuredAgentSessionThreadGoal({
    journalItems,
    journalEpoch: state.epoch,
    support: threadGoalSupport,
    reported: reportedThreadGoal,
    mutate,
    send
  })
  const transcriptPending = useMemo(
    () => pendingSendsOutsideQueuedCards(pending, queuedMessageIds, isWorking),
    [isWorking, pending, queuedMessageIds]
  )
  const contextClear = useNativeChatContextClearFloor(state.epoch, journalItems)
  // Project since the latest /clear and add a notice only for cut turns without an explaining row.
  const transcriptItems = useMemo(
    () => withNativeChatCutTurnNotices(contextClear.rows, { agentName }),
    [agentName, contextClear.rows]
  )
  const messages = useStructuredAgentSessionMessages(
    transcriptItems,
    transcriptPending,
    transportState.submissions
  )
  const editCapable = useStructuredAgentSessionHostEditsQueuedMessages(target)
  const imagesCapable = useStructuredAgentSessionHostEditsQueuedImages(target)
  const editTransport = useMemo(
    () => ({ target, sessionId, capable: editCapable, imagesCapable, write }),
    [editCapable, imagesCapable, sessionId, target, write]
  )
  const queuedController = useStructuredAgentSessionQueuedMessages({
    ...transportState,
    enabled: queueCapability === 'supported' && transportState.fence !== null,
    hasPendingPrompt: prompts.length > 0,
    isWorking,
    // Hidden from the transcript, a queue send on its way reads as sending among the cards.
    sending: pending,
    composerScopeKey: args.composerScopeKey,
    mutate,
    editTransport,
    admit,
    capturePresentation
  })
  return {
    epoch: state.epoch,
    /** Whether a live `/clear` is fading the old transcript out, and how many this view drew. */
    contextClear,
    /** The transcript has caught up with the host since this pane last started reading. */
    readCurrent: transportEnabled && readCurrent,
    rewind,
    conversationCommands,
    ...structuredConversationCommandRunner({
      agentName,
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
    /** The host's prompts still waiting on the person and its working answer. */
    hostWork: transportState.hostWork,
    subagentRoster: transportState.subagentRoster,
    messages,
    status: transportEnabled ? state.status : 'ready',
    /** Last send-return reason; failed reads use readRefusal, never raw read error text. */
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
    send,
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
      sends: { sending, stopSends: sends.stopSends }
    }),
    stopPressed: stopControl.pressed,
    queuedMessages: queuedController,
    capturePresentation,
    /** Host and send both permit queueing: follow-ups/commands request it and no unanswerable prompt blocks it. */
    sendsQueue: structuredAgentSessionNewSendsQueue(queue),
    cancel: (turnId: string | undefined, prompt?: { itemId: string; expectedRevision: number }) =>
      cancelStructuredAgentSessionPrompt(admit(), turnId, prompt),
    stopBackgroundTask: (taskId?: string) =>
      mutate<AgentSessionCancelResult>('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    respond: (item: StructuredPromptItem, response: AgentSessionPromptResponse) =>
      respondToStructuredAgentSessionPrompt({ item, response, action: admit() }),
    optionSnapshot,
    optionSurface,
    sessionCommands: transportEnabled ? (state.commands ?? undefined) : undefined,
    refreshCommands: () => refreshStructuredAgentSessionCommands(target, sessionId),
    setStructuredOption,
    /** Why the host's catalog probe says no chat can start here; the chat shows it as a notice. */
    unavailable,
    threadGoal,
    contextUsage: usage,
    /** Whether this session takes images, by its options report; undefined until it answers. */
    acceptsImages
  }
}
