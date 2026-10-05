import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type { NativeChatAsyncQuestionsField } from './native-chat-async-questions'
import {
  asyncQuestionsField,
  hostClockField,
  queuePublicationField
} from './structured-agent-session-reducer-side-fields'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionHistoryPage,
  AgentSessionQueuedMessage,
  AgentSessionQueuePause,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from './agent-session-wire'
import type { AgentSessionRefusalReference } from './agent-session-wire-refusals'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { admitAgentSessionBackgroundTaskState } from './agent-session-background-task-state-admission'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import {
  MAX_RETAINED_ITEMS,
  MAX_RETAINED_OWN_ITEMS,
  ownItemCount,
  trimRetainedItems
} from './structured-agent-session-item-retention'
import { compareAgentJournalItems } from './agent-session-journal-position'
import { readAgentJournalTurn } from './agent-session-turn-record'
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

export type StructuredAgentSessionState = {
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
  commands?: AgentSessionSlashCommand[] | null
  activity?: AgentSessionTurnActivity | null
  /** Host-derived pending async questions; absent = older host (or none published yet). */
  asyncQuestions?: NativeChatAsyncQuestionsField
  /** Absent until a frame from a host that stamps `hostNow` has been applied. */
  hostClock?: StructuredAgentHostClock
  /** Every subagent a roster row this client received named, by agent id; not trimmed with
   *  `items`. Absent until a page has been applied. */
  subagentRoster?: StructuredAgentSubagentRoster
  /** Bumped per live batch that leaves a turn row's newest revision outside the window
   *  (dropped or trimmed), so a whole-journal answer derived from turn rows is asked for again. */
  unloadedTurnRevisions?: number
}

export type StructuredAgentSessionAction =
  | { type: 'loading' }
  | { type: 'error'; message: string; refusal?: AgentSessionRefusalReference }
  | { type: 'event'; event: AgentSessionSubscribeEvent }
  | { type: 'history-page'; page: AgentSessionHistoryPage }
  | { type: 'older-page'; requestedCursor: AgentJournalCursor; page: AgentSessionHistoryPage }

const MAX_RETAINED_SUBMISSIONS = 256

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

function replacePage(
  page: AgentSessionHistoryPage,
  fence: number | null,
  backgroundTasks?: AgentSessionBackgroundTaskState | null,
  activity?: AgentSessionTurnActivity | null
): StructuredAgentSessionState {
  return {
    epoch: page.epoch,
    cursor: page.liveCursor ?? page.window.nextCursor,
    fence,
    items: [...page.items].sort(compareAgentJournalItems),
    submissions: page.submissions,
    retainedOwnItemLimit: Math.max(MAX_RETAINED_OWN_ITEMS, ownItemCount(page.items)),
    retainedItemCap: Math.max(MAX_RETAINED_ITEMS, page.items.length),
    hasOlder: page.hasOlder,
    status: 'ready',
    subagentRoster: foldStructuredAgentSubagentRosterPage(undefined, page),
    activity: activity ?? null,
    ...(backgroundTasks !== undefined
      ? { backgroundTasks }
      : page.backgroundTasks !== undefined
        ? { backgroundTasks: admitAgentSessionBackgroundTaskState(page.backgroundTasks) }
        : {})
  }
}

function mergeItems(
  current: readonly AgentJournalRenderItem[],
  incoming: readonly AgentJournalRenderItem[],
  removedIds: readonly string[]
): AgentJournalRenderItem[] {
  const removed = new Set(removedIds)
  const byId = new Map(
    current.filter((item) => !removed.has(item.itemId)).map((item) => [item.itemId, item])
  )
  for (const item of incoming) {
    const prior = byId.get(item.itemId)
    if (!prior || item.revision >= prior.revision) {
      byId.set(item.itemId, item)
    }
  }
  return [...byId.values()].sort(compareAgentJournalItems)
}

/**
 * Live rows the loaded window can take. The window is a contiguous suffix of the
 * journal, and its oldest row is the load-older anchor. A revision of a row older
 * than the window keeps that row's original sequence, so admitting it would move
 * the anchor below the window and paging `before` it would skip every row between.
 * The journal keeps the revision; the page reader serves it once the window
 * reaches the row. With nothing older on the host the window is the whole journal
 * and a row below the head (a revived tombstone) leaves no hole, so it is admitted.
 */
function liveItemsWithinWindow(
  state: StructuredAgentSessionState,
  incoming: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const head = state.items[0]
  if (!head || !state.hasOlder) {
    return incoming
  }
  return incoming.filter((item) => item.sequence >= head.sequence)
}

function mergeSubmissions(
  current: readonly AgentJournalSubmission[],
  incoming: readonly AgentJournalSubmission[],
  items: readonly AgentJournalRenderItem[]
): AgentJournalSubmission[] {
  const byId = new Map(current.map((submission) => [submission.clientMessageId, submission]))
  for (const submission of incoming) {
    byId.set(submission.clientMessageId, submission)
  }
  const sorted = [...byId.values()].sort((left, right) => left.submittedAt - right.submittedAt)
  const itemIds = new Set(
    items
      .filter((item) => item.body.kind === 'message' && item.body.role === 'user')
      .map((item) => item.itemId)
  )
  // Loaded user messages need their provider alias for durable turn attribution.
  return sorted.filter(
    (submission, index) =>
      index >= sorted.length - MAX_RETAINED_SUBMISSIONS ||
      itemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
  )
}

/** `receivedAt` is the client clock at apply time; callers pass it so the reducer stays pure. */
export function reduceStructuredAgentSession(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionAction,
  receivedAt: number = Date.now()
): StructuredAgentSessionState {
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
    return {
      ...replacePage(
        event.page,
        event.fence,
        admitAgentSessionBackgroundTaskState(event.backgroundTasks),
        event.activity
      ),
      commands: event.commands,
      ...asyncQuestionsField(event.asyncQuestions),
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
  const backgroundTasks =
    event.backgroundTasks !== undefined
      ? admitAgentSessionBackgroundTaskState(event.backgroundTasks, state.backgroundTasks)
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
    event.asyncQuestions === undefined &&
    backgroundTaskStatesEqual(backgroundTasks, state.backgroundTasks) &&
    activity?.turnId === state.activity?.turnId &&
    activity?.text === state.activity?.text &&
    state.status === 'ready' &&
    state.error === undefined
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
    ...asyncQuestionsField(event.asyncQuestions),
    ...queuePublicationField(event, state),
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
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
