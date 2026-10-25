// Group by "PR": the lanes, their order and English labels, shared by the desktop and the phone.
// Each surface reads a row's PR state its own way (the desktop from its review cache, the phone
// from the row the host sends) and hands the state here.

export type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

export const PR_GROUP_ORDER: readonly PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

/** The English copy; the desktop localizes its own, checked equal by a test. */
export const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In review',
  'in-progress': 'In progress',
  closed: 'Closed'
}

/** Section key for a PR lane. */
export function getPRLaneKey(prGroup: PRGroupKey): string {
  return `pr:${prGroup}`
}

/**
 * A PR's lane from its state. No PR (undefined), or a draft, is still in progress; a PR whose
 * state is unknown ('') is in review.
 */
export function getPRGroupKeyForState(state: string | null | undefined): PRGroupKey {
  switch (state?.toLowerCase()) {
    case undefined:
    case 'draft':
      return 'in-progress'
    case 'merged':
      return 'done'
    case 'closed':
      return 'closed'
    default:
      return 'in-review'
  }
}
