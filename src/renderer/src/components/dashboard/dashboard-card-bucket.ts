import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardDisplayState
} from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardDisplayState): DashboardBucket {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    // Why: a failure ranks like a completion (see agentTurnStoppedByUser), so it is not a question.
    case 'done':
    case 'failed':
    case 'interrupted':
      return 'done'
    case 'idle':
      return 'idle'
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/** The card's column. A verdict files like a completion (Done until seen, then Idle) while its dot
 *  keeps the mark; a failure also outranks live subagent work, as on the worktree card, but never
 *  a subagent's question. */
export function dashboardCardBucket(
  card: Pick<DashboardCard, 'dotState' | 'workingMode' | 'unseen' | 'verdictMark'>
): DashboardBucket {
  const liveBucket = dashboardBucketForDotState(
    dashboardCardDisplayState({ ...card, verdictMark: undefined })
  )
  if (!card.verdictMark || liveBucket === 'attention') {
    return liveBucket
  }
  return card.dotState === 'working' || card.unseen ? 'done' : 'idle'
}
