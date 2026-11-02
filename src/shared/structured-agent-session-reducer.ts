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

/** The last host clock sample: `hostNow - receivedAt` is the client's skew from the host,
 *  which is what lets a client attaching mid-turn anchor its live counter on the real start. */
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
  /** Head-trim floor, in the session's own rows; paging back raises it so a live batch cannot
   *  undo the page. */
  retainedOwnItemLimit: number
  /** Head-trim ceiling on every agent's rows, the memory backstop; paging back raises it too. */
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
  /** Every subagent a roster row this client received named, by agent id; not trimmed with
   *  `items`. Absent until a page has been applied. */
  subagentRoster?: StructuredAgentSubagentRoster
  /** The host's newest turn record over the whole journal, which says whether a turn runs; absent
   *  from an older host, whose answer is read off `items` instead. */
  latestTurn?: AgentSessionLatestTurn | null
  /** The prompts the host says still wait on the person (`AgentSessionHistoryPage`); absent from
   *  an older host, whose every pending prompt in `items` is read as waiting. */
  actionablePromptIds?: string[]
  /** Whether the host says the session's own agent is working (`AgentSessionHistoryPage.working`);
   *  absent from an older host, whose answer is derived from `items` and `submissions`. */
  working?: boolean
  /** Bumped per live batch that leaves a turn row's newest revision outside the window
   *  (dropped or trimmed), so a whole-journal answer derived from turn rows is asked for again. */
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
  /** `opensSubscription`: the first frame of a new subscription, which states the roster even
   *  when it resumes from a cursor; a host that omits it there has none to report. */
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
    // A live batch head-trimmed past the anchor while this read was in flight, so the
    // page no longer abuts the retained window; merging it would leave a silent hole.
    // The caller re-anchors on the new head and asks again.
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
      hasOlder: action.page.hasOlder,
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
  // Every roster revision, the window's or not: a trimmed roster row keeps its sequence.
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
    hasOlder: items.length < merged.length ? true : state.hasOlder,
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
