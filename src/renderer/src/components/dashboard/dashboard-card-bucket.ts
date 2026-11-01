import {
  dashboardCardBaseDisplayState,
  type DashboardBucket,
  type DashboardCard,
  type DashboardCardBaseDisplayState
} from '../../../../shared/dashboard-snapshot'

export function dashboardBucketForDotState(state: DashboardCardBaseDisplayState): DashboardBucket {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
      return 'done'
    case 'idle':
      return 'idle'
    case 'blocked':
    case 'waiting':
      return 'attention'
  }
}

/** The state facts both bucket producers read; keeps the snapshot builder and the pop-out patch in lockstep. */
type DashboardCardBucketFacts = Pick<DashboardCard, 'dotState' | 'workingMode' | 'unseen'>

/**
 * Column rules shared by the snapshot builder and the pop-out's live status patch so they never drift.
 * An unopened completion still owes the user a review (a plain-text question ends its turn with a
 * normal Stop and no hook prompt), so it groups with hook questions in Needs You; the acknowledged
 * fold inside dashboardCardBaseDisplayState keeps settling opened completions into idle.
 */
export function dashboardCardBucket(card: DashboardCardBucketFacts): DashboardBucket {
  if (card.dotState === 'done' && card.unseen) {
    return 'attention'
  }
  return dashboardBucketForDotState(dashboardCardBaseDisplayState(card))
}
