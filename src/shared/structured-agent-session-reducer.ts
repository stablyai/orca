import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type {
  AgentSessionHandoffStatus,
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from './agent-session-wire'

export type StructuredAgentSessionState = {
  epoch: string | null
  cursor: AgentJournalCursor | null
  fence: number | null
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  hasOlder: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
  handoff: AgentSessionHandoffStatus | null
}

export type StructuredAgentSessionAction =
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'handoff'; handoff: AgentSessionHandoffStatus }
  | { type: 'event'; event: AgentSessionSubscribeEvent }
  | { type: 'tail-page'; page: AgentSessionHistoryPage }
  | { type: 'older-page'; requestedEpoch: string; page: AgentSessionHistoryPage }

export const EMPTY_STRUCTURED_AGENT_SESSION: StructuredAgentSessionState = {
  epoch: null,
  cursor: null,
  fence: null,
  items: [],
  submissions: [],
  hasOlder: false,
  status: 'idle',
  handoff: null
}

const MAX_RETAINED_SUBMISSIONS = 256

function replacePage(
  page: AgentSessionHistoryPage,
  fence: number,
  handoff?: AgentSessionHandoffStatus
): StructuredAgentSessionState {
  return {
    epoch: page.epoch,
    cursor: page.liveCursor ?? page.window.nextCursor,
    fence,
    items: [...page.items].sort((left, right) => left.sequence - right.sequence),
    submissions: page.submissions,
    hasOlder: page.hasOlder,
    status: 'ready',
    handoff: handoff ?? null
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

function mergeSubmissions(
  current: readonly AgentJournalSubmission[],
  incoming: readonly AgentJournalSubmission[]
): AgentJournalSubmission[] {
  const byId = new Map(current.map((submission) => [submission.clientMessageId, submission]))
  for (const submission of incoming) {
    byId.set(submission.clientMessageId, submission)
  }
  return [...byId.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .slice(-MAX_RETAINED_SUBMISSIONS)
}

export function reduceStructuredAgentSession(
  state: StructuredAgentSessionState,
  action: StructuredAgentSessionAction
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
      if (
        pageCursor?.sequence === state.cursor.sequence &&
        action.page.fence !== undefined &&
        action.page.fence !== state.fence
      ) {
        return { ...state, fence: action.page.fence, status: 'ready', error: undefined }
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
        ? mergeSubmissions(state.submissions, action.page.submissions)
        : action.page.submissions,
      hasOlder: action.page.hasOlder,
      status: 'ready',
      handoff: state.handoff
    }
  }
  if (action.type === 'older-page') {
    if (state.epoch !== action.requestedEpoch || action.page.epoch !== action.requestedEpoch) {
      return state
    }
    return {
      ...state,
      items: mergeItems(state.items, action.page.items, action.page.removedItemIds),
      submissions: mergeSubmissions(state.submissions, action.page.submissions),
      hasOlder: action.page.hasOlder
    }
  }
  const event = action.event
  if (event.type === 'end') {
    return state
  }
  if (event.type === 'snapshot' || event.type === 'reset') {
    return replacePage(event.page, event.fence, event.handoff)
  }
  if (state.epoch !== event.batch.cursor.epoch) {
    return state
  }
  if (state.cursor && event.batch.cursor.sequence < state.cursor.sequence) {
    return state
  }
  return {
    ...state,
    cursor: event.batch.cursor,
    fence: event.fence ?? state.fence,
    items: mergeItems(state.items, event.batch.items, event.batch.removedItemIds),
    submissions: mergeSubmissions(state.submissions, event.batch.submissions),
    status: 'ready',
    error: undefined,
    handoff: event.handoff ?? state.handoff
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
