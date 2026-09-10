import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionSlashCommand,
  AgentSessionHandoffStatus,
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent,
  AgentSessionTurnActivity
} from './agent-session-wire'
import { backgroundTaskStatesEqual } from './agent-session-background-task-state-equality'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'

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
  /** Head-trim floor for `items`; paging back raises it so a live batch cannot undo the page. */
  retainedItemLimit: number
  hasOlder: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  handoff: AgentSessionHandoffStatus | null
  backgroundTasks?: AgentSessionBackgroundTaskState | null
  commands?: AgentSessionSlashCommand[] | null
  activity?: AgentSessionTurnActivity | null
  /** Absent until a frame from a host that stamps `hostNow` has been applied. */
  hostClock?: StructuredAgentHostClock
}

export type StructuredAgentSessionAction =
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'handoff'; handoff: AgentSessionHandoffStatus }
  | { type: 'event'; event: AgentSessionSubscribeEvent }
  | { type: 'tail-page'; page: AgentSessionHistoryPage }
  | { type: 'older-page'; requestedEpoch: string; page: AgentSessionHistoryPage }

const MAX_RETAINED_SUBMISSIONS = 256
// Well above the renderer's initial read window (300) plus a page, so only genuinely
// long live sessions trim; anything trimmed is still reachable by paging older.
const MAX_RETAINED_ITEMS = 1024

export const EMPTY_STRUCTURED_AGENT_SESSION: StructuredAgentSessionState = {
  epoch: null,
  cursor: null,
  fence: null,
  items: [],
  submissions: [],
  retainedItemLimit: MAX_RETAINED_ITEMS,
  hasOlder: false,
  status: 'idle',
  handoff: null
}

/** A frame without `hostNow` (older host) leaves the previous sample in place. */
function hostClockField(
  hostNow: number | undefined,
  receivedAt: number,
  previous: StructuredAgentHostClock | undefined
): { hostClock?: StructuredAgentHostClock } {
  const hostClock = hostNow !== undefined ? { hostNow, receivedAt } : previous
  return hostClock ? { hostClock } : {}
}

function replacePage(
  page: AgentSessionHistoryPage,
  fence: number,
  handoff?: AgentSessionHandoffStatus,
  backgroundTasks?: AgentSessionBackgroundTaskState | null,
  activity?: AgentSessionTurnActivity | null
): StructuredAgentSessionState {
  return {
    epoch: page.epoch,
    cursor: page.liveCursor ?? page.window.nextCursor,
    fence,
    items: [...page.items].sort((left, right) => left.sequence - right.sequence),
    submissions: page.submissions,
    retainedItemLimit: Math.max(MAX_RETAINED_ITEMS, page.items.length),
    hasOlder: page.hasOlder,
    status: 'ready',
    handoff: handoff ?? null,
    activity: activity ?? null,
    ...(backgroundTasks !== undefined
      ? { backgroundTasks }
      : page.backgroundTasks !== undefined
        ? { backgroundTasks: page.backgroundTasks }
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
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function trimRetainedItems(
  items: AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  return items.length <= limit ? items : items.slice(items.length - limit)
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
    return { ...state, status: 'loading', error: undefined }
  }
  if (action.type === 'error') {
    return { ...state, status: 'error', error: action.message }
  }
  if (action.type === 'handoff') {
    return { ...state, handoff: action.handoff }
  }
  if (action.type === 'tail-page') {
    const pageCursor = action.page.liveCursor ?? action.page.window.newest
    // An equal cursor means the page holds nothing the stream has not already
    // delivered; replacing would throw away paged-in older items mid-scroll.
    if (
      state.epoch === action.page.epoch &&
      state.cursor &&
      (!pageCursor || pageCursor.sequence <= state.cursor.sequence)
    ) {
      const backgroundTasksChanged =
        action.page.backgroundTasks !== undefined &&
        !backgroundTaskStatesEqual(action.page.backgroundTasks, state.backgroundTasks)
      if (
        pageCursor?.sequence === state.cursor.sequence &&
        ((action.page.fence !== undefined && action.page.fence !== state.fence) ||
          backgroundTasksChanged)
      ) {
        return {
          ...state,
          ...(action.page.fence !== undefined ? { fence: action.page.fence } : {}),
          ...(action.page.backgroundTasks !== undefined
            ? { backgroundTasks: action.page.backgroundTasks }
            : {}),
          ...hostClockField(action.page.hostNow, receivedAt, state.hostClock),
          status: 'ready',
          error: undefined
        }
      }
      return state
    }
    const sameEpoch = state.epoch === action.page.epoch
    return {
      epoch: action.page.epoch,
      cursor: action.page.liveCursor ?? null,
      fence: action.page.fence ?? null,
      items: action.page.items,
      submissions: sameEpoch
        ? mergeSubmissions(state.submissions, action.page.submissions, action.page.items)
        : action.page.submissions,
      retainedItemLimit: Math.max(MAX_RETAINED_ITEMS, action.page.items.length),
      hasOlder: action.page.hasOlder,
      status: 'ready',
      handoff: state.handoff,
      ...(sameEpoch ? { commands: state.commands } : {}),
      ...(sameEpoch && state.activity !== undefined ? { activity: state.activity } : {}),
      ...(action.page.backgroundTasks !== undefined
        ? { backgroundTasks: action.page.backgroundTasks }
        : state.backgroundTasks !== undefined
          ? { backgroundTasks: state.backgroundTasks }
          : {}),
      ...hostClockField(action.page.hostNow, receivedAt, state.hostClock)
    }
  }
  if (action.type === 'older-page') {
    if (state.epoch !== action.requestedEpoch || action.page.epoch !== action.requestedEpoch) {
      return state
    }
    const items = mergeItems(state.items, action.page.items, action.page.removedItemIds)
    return {
      ...state,
      items,
      retainedItemLimit: Math.max(state.retainedItemLimit, items.length),
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
      ...replacePage(event.page, event.fence, event.handoff, event.backgroundTasks, event.activity),
      commands: event.commands,
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
    event.backgroundTasks !== undefined ? event.backgroundTasks : state.backgroundTasks
  const activity = event.activity !== undefined ? event.activity : state.activity
  const journalUnchanged =
    event.batch.items.length === 0 &&
    event.batch.removedItemIds.length === 0 &&
    event.batch.submissions.length === 0
  if (
    event.batch.cursor.sequence === state.cursor?.sequence &&
    journalUnchanged &&
    (event.fence === undefined || event.fence === state.fence) &&
    (event.handoff === undefined || event.handoff === state.handoff) &&
    (event.commands === undefined || event.commands === state.commands) &&
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
    : mergeItems(state.items, event.batch.items, event.batch.removedItemIds)
  const items = trimRetainedItems(merged, state.retainedItemLimit)
  return {
    ...state,
    cursor: event.batch.cursor,
    fence: event.fence ?? state.fence,
    items,
    // A trim leaves older items behind the cursor, so paging must stay offered.
    hasOlder: items.length < merged.length ? true : state.hasOlder,
    submissions:
      event.batch.submissions.length === 0 && event.batch.removedItemIds.length === 0
        ? state.submissions
        : mergeSubmissions(state.submissions, event.batch.submissions, items),
    status: 'ready',
    error: undefined,
    handoff: event.handoff ?? state.handoff,
    commands: event.commands !== undefined ? event.commands : state.commands,
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    ...(activity !== undefined ? { activity } : {}),
    ...hostClockField(event.hostNow, receivedAt, state.hostClock)
  }
}

export function oldestStructuredAgentSessionCursor(
  state: StructuredAgentSessionState
): AgentJournalCursor | null {
  const oldest = state.items[0]
  return state.epoch && oldest ? { epoch: state.epoch, sequence: oldest.sequence } : null
}

export function shouldAdvanceStructuredResumeCursor(
  current: AgentJournalCursor | null,
  incoming: AgentJournalCursor
): boolean {
  return (
    current === null || (current.epoch === incoming.epoch && incoming.sequence >= current.sequence)
  )
}
