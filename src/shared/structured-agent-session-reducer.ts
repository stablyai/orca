import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'
import {
  hostClockField,
  replacePage,
  mergeItems,
  liveItemsWithinWindow
} from './structured-agent-session-history-state'
import {
  currentRequestsAfterEvent,
  currentRequestsState,
  applyCurrentRequestsMarker,
  type AgentSessionCurrentRequestsState
} from './agent-session-current-requests'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionHistoryPage,
  AgentSessionLatestTurn,
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from './agent-session-wire'
import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { admitAgentSessionBackgroundTaskState } from './agent-session-background-task-state-admission'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  mergeSubmissions,
  ownItemCount,
  trimRetainedItems
} from './structured-agent-session-item-retention'
import { readAgentJournalTurn } from './agent-session-turn-record'
import { agentSessionHasOlderTranscript } from './agent-session-context-clear'
import { queuePublicationField } from './structured-agent-session-queue-publication-field'
import {
  actionablePromptIdsAfterStructuredAgentSessionBatch,
  hostWorkingAfterStructuredAgentSessionBatch,
  latestTurnAfterStructuredAgentSessionBatch,
  restatesStructuredAgentSessionHostWork
} from './structured-agent-session-live-turn'
import {
  foldStructuredAgentSubagentRoster,
  foldStructuredAgentSubagentRosterPage,
  NO_STRUCTURED_AGENT_SUBAGENT_ROSTER,
  type StructuredAgentSubagentRoster
} from './structured-agent-session-subagent-roster'

/** Sample hostNow/receivedAt to convert host turn starts into client-clock anchors when attaching mid-turn. */
export type StructuredAgentHostClock = {
  hostNow: number
  receivedAt: number
}

export type StructuredAgentSessionState = AgentSessionCurrentRequestsState & {
  epoch: string | null
  cursor: AgentJournalCursor | null
  fence: number | null
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  /** Own-row trim floor grows with paging so live batches cannot undo loaded history. */
  retainedOwnItemLimit: number
  /** All-agent memory ceiling grows with paging too. */
  retainedItemCap: number
  hasOlder: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** The failed read's own text, for logs; a surface words `readRefusal` instead. */
  error?: string
  /** The refusal the failed read met, when the host sent one; cleared with `error`. */
  readRefusal?: AgentSessionRefusalReference
  backgroundTasks?: AgentSessionBackgroundTaskState | null
  /** Host-held drafts. Absent = no claim yet (older host); `[]`/null = empty. */
  queuedMessages?: AgentSessionQueuedMessage[] | null
  /** The queue's pause, published with the list; null when it sends on its own. */
  queuePause?: AgentSessionQueuePause | null
  /** Published with the list: the card the queue sends next once nothing runs, else null. */
  nextQueuedMessageId?: string | null
  commands?: AgentSessionSlashCommand[] | null
  activity?: AgentSessionTurnActivity | null
  /** Absent until a frame from a host that stamps `hostNow` has been applied. */
  hostClock?: StructuredAgentHostClock
  /** Retain received roster entries by agent ID beyond the item window; absent until a page arrives. */
  subagentRoster?: StructuredAgentSubagentRoster
  /** Whole-journal turn state; older hosts omit it and require loaded-item fallback. */
  latestTurn?: AgentSessionLatestTurn | null
  /** Host-actionable prompts; older hosts treat every pending item as waiting. */
  actionablePromptIds?: string[]
  /** Host main-agent work state; older hosts derive from items/submissions. */
  working?: boolean
  /** Bump when a live turn revision falls outside the window so whole-journal turn readers refresh. */
  unloadedTurnRevisions?: number
}

export type StructuredAgentSessionAction =
  | { type: 'loading' }
  | { type: 'requests-marker'; marker: AgentSessionCurrentRequestsMarker }
  | {
      type: 'requests-complete'
      marker: AgentSessionCurrentRequestsMarker
      items: AgentJournalRenderItem[]
    }
  | { type: 'error'; message: string; refusal?: AgentSessionRefusalReference }
  /** First subscription frame restates the roster even on cursor resume; an old host omitting it has no running children. */
  | {
      type: 'event'
      event: AgentSessionSubscribeEvent
      opensSubscription?: boolean
    }
  | { type: 'history-page'; page: AgentSessionHistoryPage }
  | {
      type: 'older-page'
      requestedCursor: AgentJournalCursor
      page: AgentSessionHistoryPage
    }

export const EMPTY_STRUCTURED_AGENT_SESSION: StructuredAgentSessionState = {
  epoch: null,
  cursor: null,
  fence: null,
  items: [],
  submissions: [],
  retainedOwnItemLimit: MAX_RETAINED_OWN_ITEMS,
  retainedItemCap: MAX_RETAINED_ITEMS,
  hasOlder: false,
  status: 'idle'
}

/** `receivedAt` is the client clock at apply time; callers pass it so the reducer stays pure. */
export function reduceStructuredAgentSession(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionAction,
  receivedAt: number = Date.now()
): StructuredAgentSessionState {
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
    return {
      ...state,
      status: 'loading',
      error: undefined,
      readRefusal: undefined
    }
  }
  if (action.type === 'error') {
    return {
      ...state,
      status: 'error',
      error: action.message,
      readRefusal: action.refusal
    }
  }
  if (action.type === 'history-page') {
    return {
      ...replacePage(action.page, action.page.fence ?? null, state.backgroundTasks, state.activity),
      ...currentRequestsState(state),
      commands: state.commands,
      // Live subscription state stays authoritative over a possibly stale history answer.
      ...queuePublicationField(state, action.page),
      ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
    }
  }
  if (action.type === 'older-page') {
    const requested = action.requestedCursor
    if (state.epoch !== requested.epoch || action.page.epoch !== requested.epoch) {
      return state
    }
    const head = state.items[0]
    // Head trim overtook the requested anchor; merging would leave a hole. Caller must retry from the new head.
    if (head && head.sequence > requested.sequence) {
      return state
    }
    const items = mergeItems(state.items, action.page.items, action.page.removedItemIds)
    return {
      ...state,
      items,
      retainedOwnItemLimit: Math.max(state.retainedOwnItemLimit, ownItemCount(items)),
      retainedItemCap: Math.max(state.retainedItemCap, items.length),
      subagentRoster: foldStructuredAgentSubagentRosterPage(state.subagentRoster, action.page),
      submissions: mergeSubmissions(state.submissions, action.page.submissions, items),
      hasOlder: agentSessionHasOlderTranscript(items, action.page.hasOlder),
      ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
    }
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
      // A snapshot omits the list when unchanged since the last frame sent to this subscriber.
      ...queuePublicationField(event, event.page, state),
      ...hostClockField(event.hostNow, receivedAt, state.hostClock)
    }
  }
  if (state.epoch !== event.batch.cursor.epoch) {
    return state
  }
  if (state.cursor && event.batch.cursor.sequence < state.cursor.sequence) {
    return state
  }
  const requests = currentRequestsAfterEvent(state, event, action.opensSubscription === true)
  const backgroundTasks =
    event.backgroundTasks !== undefined
      ? admitAgentSessionBackgroundTaskState(event.backgroundTasks, state.backgroundTasks)
      : action.opensSubscription
        ? undefined
        : state.backgroundTasks
  const activity = event.activity !== undefined ? event.activity : state.activity
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
    state.status === 'ready' &&
    state.error === undefined &&
    requests.currentRequests === state.currentRequests &&
    requests.requestMarker === state.requestMarker &&
    requests.requestAuthority === state.requestAuthority
  ) {
    return state
  }
  const merged = journalUnchanged
    ? state.items
    : mergeItems(state.items, liveItems, event.batch.removedItemIds)
  const items = trimRetainedItems(merged, state.retainedOwnItemLimit, state.retainedItemCap)
  const outsideWindow = [
    ...(liveItems.length < event.batch.items.length
      ? event.batch.items.filter((item) => !liveItems.includes(item))
      : []),
    ...merged.slice(0, merged.length - items.length)
  ]
  const lostTurnRow = outsideWindow.some((item) => readAgentJournalTurn(item.body) !== null)
  return {
    ...state,
    ...requests,
    cursor: event.batch.cursor,
    fence: event.fence ?? state.fence,
    items,
    subagentRoster,
    // A trim leaves older items behind the cursor, so paging must stay offered.
    hasOlder: agentSessionHasOlderTranscript(items, items.length < merged.length || state.hasOlder),
    submissions:
      event.batch.submissions.length === 0 && event.batch.removedItemIds.length === 0
        ? state.submissions
        : mergeSubmissions(state.submissions, event.batch.submissions, items),
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
    ...queuePublicationField(event, state),
    backgroundTasks,
    ...(activity !== undefined ? { activity } : {}),
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
