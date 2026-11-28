import { AGENT_SESSION_DISPATCH_LIMITS } from '../../journal/agent-session-dispatch-limits'
import {
  applyProviderReceived,
  isProviderReceiptOnly,
  providerAttemptsAfterBatch
} from './agent-session-provider-received'
import {
  mergeOlderStructuredAgentSessionPage,
  trimStructuredAgentSessionHistory
} from './structured-agent-session-history-retention'
import {
  hostClockField,
  replacePage,
  mergeLiveItems,
  liveItemsWithinWindow,
  hasOlderAfterMerge
} from '../structured-agent-session-history-state'
import {
  currentRequestsAfterEvent,
  currentRequestsState,
  applyCurrentRequestsMarker
} from '../../requests/agent-session-current-requests'
import type { AgentJournalCursor } from '../../journal/agent-session-journal-identity'
import type {
  StructuredAgentSessionAction,
  StructuredAgentSessionState
} from './structured-agent-session-reducer-state'
import { backgroundTaskStatesEqual } from '../../background-tasks/agent-session-background-task-state-equality'
import { admitAgentSessionBackgroundTaskState } from '../../background-tasks/agent-session-background-task-state-admission'
import {
  LIVE_TRIM_SLACK_OWN_ITEMS,
  mergeSubmissions,
  trimRetainedItems
} from '../structured-agent-session-item-retention'
import { readAgentJournalTurn } from '../../lifecycle/records/agent-session-turn-record'
import { queuePublicationRetainingMail } from './retain-queued-mail-blocks'
import {
  actionablePromptIdsAfterStructuredAgentSessionBatch,
  hostWorkingAfterStructuredAgentSessionBatch,
  latestTurnAfterStructuredAgentSessionBatch,
  restatesStructuredAgentSessionHostWork
} from '../structured-agent-session-live-turn'
import {
  foldStructuredAgentSubagentRoster,
  NO_STRUCTURED_AGENT_SUBAGENT_ROSTER
} from '../structured-agent-session-subagent-roster'

export {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentHostClock,
  type StructuredAgentSessionAction,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer-state'

/** `receivedAt` is the client clock at apply time; callers pass it so the reducer stays pure. */
export function reduceStructuredAgentSession(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionAction,
  receivedAt: number = Date.now()
): StructuredAgentSessionState {
  if (action.type === 'clear-provider-received') {
    return state.providerReceived || state.pendingProviderAttempts
      ? { ...state, providerReceived: undefined, pendingProviderAttempts: undefined }
      : state
  }
  if (action.type === 'trim-history') {
    return trimStructuredAgentSessionHistory(state)
  }
  if (action.type === 'requests-marker') {
    return { ...state, ...applyCurrentRequestsMarker(state, action.marker) }
  }
  if (action.type === 'requests-complete') {
    return action.marker.version === state.requestMarker?.version
      ? { ...state, currentRequests: action.items, requestAuthority: action.marker }
      : state
  }
  if (action.type === 'loading') {
    // Keep the last transcript visible while a reconnect rehydrates the stream.
    return { ...state, status: 'loading', error: undefined, readRefusal: undefined }
  }
  if (action.type === 'error') {
    return { ...state, status: 'error', error: action.message, readRefusal: action.refusal }
  }
  if (action.type === 'history-page') {
    return {
      ...replacePage(action.page, action.page.fence ?? null, state.backgroundTasks, state.activity),
      ...currentRequestsState(state),
      promptSuggestion: state.promptSuggestion,
      commands: state.commands,
      // Live subscription state stays authoritative over a possibly stale history answer.
      ...queuePublicationRetainingMail(state.queuedMessages, state, action.page),
      ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
    }
  }
  if (action.type === 'older-page') {
    return mergeOlderStructuredAgentSessionPage(state, action, receivedAt)
  }
  const event = action.event
  if (event.type === 'end') {
    return state
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    const requests = currentRequestsAfterEvent(state, event, true)
    return {
      ...replacePage(
        event.page,
        event.fence,
        admitAgentSessionBackgroundTaskState(event.backgroundTasks),
        event.activity
      ),
      ...requests,
      status: 'ready',
      commands: event.commands,
      promptSuggestion: state.promptSuggestion,
      // A snapshot omits the list when unchanged since the last frame sent to this subscriber.
      ...queuePublicationRetainingMail(state.queuedMessages, event, event.page, state),
      ...hostClockField(event.hostNow, receivedAt, state.hostClock)
    }
  }
  if (state.epoch !== event.batch.cursor.epoch) {
    return state
  }
  if (state.cursor && event.batch.cursor.sequence < state.cursor.sequence) {
    return state
  }
  const receiptProvider = action.receiptProvider
  const receiptAuthorityChanged =
    action.opensSubscription || (event.fence !== undefined && event.fence !== state.fence)
  if (isProviderReceiptOnly(event) && event.batch.cursor.sequence === state.cursor?.sequence) {
    if (!receiptProvider || receiptAuthorityChanged) {
      return state
    }
    const providerReceived = applyProviderReceived(
      state,
      event.providerReceived,
      AGENT_SESSION_DISPATCH_LIMITS[receiptProvider]
    )
    return providerReceived === state.providerReceived ? state : { ...state, providerReceived }
  }
  const requests = currentRequestsAfterEvent(state, event, action.opensSubscription === true)
  const backgroundTasks =
    event.backgroundTasks !== undefined
      ? admitAgentSessionBackgroundTaskState(event.backgroundTasks, state.backgroundTasks)
      : action.opensSubscription
        ? undefined
        : state.backgroundTasks
  const activity = event.activity !== undefined ? event.activity : state.activity
  const promptSuggestion =
    event.promptSuggestion !== undefined ? event.promptSuggestion : state.promptSuggestion
  const liveItems = liveItemsWithinWindow(state, event.batch.items)
  // Fold every roster revision even outside the window; trimmed rows retain their sequence.
  const subagentRoster = foldStructuredAgentSubagentRoster(
    state.subagentRoster ?? NO_STRUCTURED_AGENT_SUBAGENT_ROSTER,
    event.batch.items,
    event.batch.removedItemIds
  )
  const journalUnchanged =
    liveItems.length === 0 &&
    event.batch.removedItemIds.length === 0 &&
    event.batch.submissions.length === 0
  if (
    !(receiptAuthorityChanged && (state.providerReceived || state.pendingProviderAttempts)) &&
    !event.providerReceived?.length &&
    event.batch.cursor.sequence === state.cursor?.sequence &&
    journalUnchanged &&
    subagentRoster === (state.subagentRoster ?? NO_STRUCTURED_AGENT_SUBAGENT_ROSTER) &&
    (event.fence === undefined || event.fence === state.fence) &&
    (event.commands === undefined || event.commands === state.commands) &&
    (event.queuedMessages === undefined || event.queuedMessages === state.queuedMessages) &&
    (event.queuePause === undefined || event.queuePause === state.queuePause) &&
    (event.nextQueuedMessageId === undefined ||
      event.nextQueuedMessageId === state.nextQueuedMessageId) &&
    backgroundTaskStatesEqual(backgroundTasks, state.backgroundTasks) &&
    restatesStructuredAgentSessionHostWork(event, state) &&
    activity?.turnId === state.activity?.turnId &&
    activity?.text === state.activity?.text &&
    promptSuggestion?.id === state.promptSuggestion?.id &&
    state.status === 'ready' &&
    state.error === undefined &&
    requests.currentRequests === state.currentRequests &&
    requests.requestMarker === state.requestMarker &&
    requests.requestAuthority === state.requestAuthority
  ) {
    return state
  }
  const { items: merged, rescan } = journalUnchanged
    ? { items: state.items, rescan: false }
    : mergeLiveItems(state.items, liveItems, event.batch.removedItemIds)
  const items = !rescan
    ? merged
    : trimRetainedItems(
        merged,
        state.retainedOwnItemLimit,
        state.retainedItemCap,
        LIVE_TRIM_SLACK_OWN_ITEMS
      )
  const outsideWindow = [
    ...(liveItems.length < event.batch.items.length
      ? event.batch.items.filter((item) => !liveItems.includes(item))
      : []),
    ...merged.slice(0, merged.length - items.length)
  ]
  const lostTurnRow = outsideWindow.some((item) => readAgentJournalTurn(item.body) !== null)
  const submissions =
    event.batch.submissions.length === 0 && event.batch.removedItemIds.length === 0
      ? state.submissions
      : mergeSubmissions(state.submissions, event.batch.submissions, items)
  return {
    ...state,
    ...requests,
    ...(receiptProvider
      ? providerAttemptsAfterBatch(
          receiptAuthorityChanged
            ? {}
            : {
                providerReceived: state.providerReceived,
                pendingProviderAttempts: state.pendingProviderAttempts
              },
          event,
          liveItems,
          outsideWindow,
          receiptProvider
        )
      : {}),
    cursor: event.batch.cursor,
    fence: event.fence ?? state.fence,
    items,
    subagentRoster,
    hasOlder: hasOlderAfterMerge(state.items, items, items.length < merged.length, state.hasOlder),
    submissions,
    status: 'ready',
    error: undefined,
    readRefusal: undefined,
    commands: event.commands !== undefined ? event.commands : state.commands,
    latestTurn: latestTurnAfterStructuredAgentSessionBatch(state.latestTurn, event),
    actionablePromptIds: actionablePromptIdsAfterStructuredAgentSessionBatch(
      state.actionablePromptIds,
      event
    ),
    working: hostWorkingAfterStructuredAgentSessionBatch(state.working, event),
    ...queuePublicationRetainingMail(state.queuedMessages, event, state),
    backgroundTasks,
    ...(activity !== undefined ? { activity } : {}),
    ...(promptSuggestion !== undefined ? { promptSuggestion } : {}),
    ...(lostTurnRow ? { unloadedTurnRevisions: (state.unloadedTurnRevisions ?? 0) + 1 } : {}),
    ...hostClockField(event.hostNow, receivedAt, state.hostClock)
  }
}

export function oldestStructuredAgentSessionCursor(
  state: StructuredAgentSessionState
): AgentJournalCursor | null {
  const oldest = state.items[0]
  return state.epoch && oldest ? { epoch: state.epoch, sequence: oldest.sequence } : null
}
