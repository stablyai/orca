import type { SessionGridFilter } from '../../../../shared/session-grid-types'
import type { SessionGridBucketCounts } from './session-grid-items-builder'

/**
 * Why the grid has nothing to draw, which is three different things wearing one screen.
 *
 * "No active sessions" beside a live "Hidden 2" chip and a lit filter chip contradicts
 * itself, and the New Session button it offered answered a question the user had not asked —
 * the sessions are open, they are just not being shown.
 *
 * Only called for an empty `items`, and it reads the two populations the listing already
 * publishes to tell WHICH step emptied it. `stateCounts` tallies the cards under the
 * workspace filter that survived the hidden subtraction, so a non-zero total means the
 * state chip is what took the last card off; a zero total with something hidden means the
 * hiding did; a zero total with neither means the workspace chip is pointing somewhere
 * with no sessions of its own.
 */
export type SessionGridEmptyStateReason = 'no-sessions' | 'hidden' | 'filtered'

export function resolveSessionGridEmptyStateReason(input: {
  /** Every card the grid knows, before either filter axis and before the hidden subtraction. */
  allItemCount: number
  /** Per-bucket tallies: cards under the workspace filter, hidden ones already subtracted. */
  stateCounts: SessionGridBucketCounts
  /** Hidden cards in the current workspace scope, revealed or not. */
  hiddenCount: number
  activeFilter: SessionGridFilter
}): SessionGridEmptyStateReason {
  if (input.allItemCount === 0) {
    return 'no-sessions'
  }
  const inScope = Object.values(input.stateCounts).reduce((sum, count) => sum + count, 0)
  if (inScope > 0) {
    return 'filtered'
  }
  if (input.hiddenCount > 0) {
    return 'hidden'
  }
  return input.activeFilter === 'all' ? 'no-sessions' : 'filtered'
}
