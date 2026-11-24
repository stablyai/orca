import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'

// Above initial 300-row reads plus a page; trims remain pageable. Count own rows so hidden child output cannot crowd out the conversation.
export const MAX_RETAINED_OWN_ITEMS = 1024
// Bounds the memory and the rows every live delta re-derives the transcript over.
export const MAX_RETAINED_ITEMS = 4 * MAX_RETAINED_OWN_ITEMS

export function ownItemCount(items: readonly AgentJournalRenderItem[]): number {
  return items.reduce((count, item) => (isRootAgentJournalItem(item) ? count + 1 : count), 0)
}

// Live commits trim only past the limits by this margin, so most appends keep every row's position for incremental projection.
export const LIVE_TRIM_SLACK_OWN_ITEMS = 128

/** Trim only through an own row; paged-in child rows at the head survive until an own row pushes them out. */
export function trimRetainedItems(
  items: AgentJournalRenderItem[],
  ownLimit: number,
  cap: number,
  slack = 0
): AgentJournalRenderItem[] {
  if (slack > 0 && retainedStart(items, ownLimit + slack, cap + 4 * slack) === 0) {
    return items
  }
  const start = retainedStart(items, ownLimit, cap)
  return start === 0 ? items : items.slice(start)
}

function retainedStart(
  items: readonly AgentJournalRenderItem[],
  ownLimit: number,
  cap: number
): number {
  const start = Math.max(0, items.length - cap)
  let own = 0
  for (let index = items.length - 1; index >= start; index -= 1) {
    if (!isRootAgentJournalItem(items[index])) {
      continue
    }
    own += 1
    if (own > ownLimit) {
      return index + 1
    }
  }
  return start
}

const MAX_RETAINED_SUBMISSIONS = 256

export function mergeSubmissions(
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
