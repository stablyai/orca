// Mirrors GitHub's MergeQueueEntryState; other providers never set an entry.
const REVIEW_MERGE_QUEUE_ENTRY_STATES = [
  'QUEUED',
  'AWAITING_CHECKS',
  'MERGEABLE',
  'UNMERGEABLE',
  'LOCKED'
] as const

export type ReviewMergeQueueEntryState = (typeof REVIEW_MERGE_QUEUE_ENTRY_STATES)[number]

/**
 * A review's place in its base branch's merge queue.
 * On review payloads: `undefined` = not checked, `null` = checked and not queued.
 */
export type ReviewMergeQueueEntry = {
  /** 1-based; `null` when the provider did not report a position. */
  position: number | null
  /** `null` for a state this version does not know, so newer hosts stay readable. */
  state: ReviewMergeQueueEntryState | null
}

function isReviewMergeQueueEntryState(value: unknown): value is ReviewMergeQueueEntryState {
  return REVIEW_MERGE_QUEUE_ENTRY_STATES.some((state) => state === value)
}

export function parseReviewMergeQueueEntry(raw: unknown): ReviewMergeQueueEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const position = 'position' in raw ? raw.position : undefined
  const state = 'state' in raw ? raw.state : undefined
  return {
    position:
      typeof position === 'number' && Number.isInteger(position) && position > 0 ? position : null,
    state: isReviewMergeQueueEntryState(state) ? state : null
  }
}
