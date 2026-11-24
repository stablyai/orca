// Desktop and phone share PR lanes, ordering and labels; each supplies state from its own cache or host row.

export type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

export const PR_GROUP_ORDER: readonly PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

/** The English copy; the desktop localizes its own, checked equal by a test. */
export const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In review',
  'in-progress': 'In progress',
  closed: 'Closed'
}

export function getPRLaneKey(prGroup: PRGroupKey): string {
  return `pr:${prGroup}`
}

/** Missing reviews and drafts are in progress; an unknown state (empty string) is in review. */
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
