/**
 * Reading a worktree's tab row without turning "no row yet" into "no tabs".
 *
 * `tabsByWorktree` has no entry for a worktree the client has not placed yet. A cold launch, a
 * stalled host snapshot and a profile that has never held the workspace all sit in that state for
 * a while. Reading it as an empty array makes an unanswered question look like a confident answer,
 * and a settle loop then agrees with itself about a tab set it never actually saw.
 */

/** Either the client has a row for this worktree, or it does not. Those are different facts. */
export type WorktreeTabObservation = { present: false } | { present: true; tabIds: string[] }

/** What `page.evaluate` hands back: the row's tab ids, or `null` for "no row". */
export type WorktreeTabRow = string[] | null

export function toWorktreeTabObservation(row: WorktreeTabRow): WorktreeTabObservation {
  return row === null ? { present: false } : { present: true, tabIds: row }
}

export function describeWorktreeTabObservation(observation: WorktreeTabObservation): string {
  return observation.present ? `tabs=[${observation.tabIds.join(' ')}]` : 'no worktree row'
}

/**
 * A stable key per observation. `absent` can never collide with a present-but-empty row, which is
 * the collision that let the settle loop below count an unanswered read as an agreement.
 */
export function worktreeTabObservationKey(observation: WorktreeTabObservation): string {
  return observation.present ? `present:${observation.tabIds.join(' ')}` : 'absent'
}

export type WorktreeTabSettleOptions = {
  /**
   * Whether a missing row can end the wait. `true` for a workspace the client is expected to hold
   * — there the absence is the thing still loading, never the answer. `false` where "this client
   * holds nothing for that worktree" is itself a legitimate resting state.
   */
  requirePresentRow: boolean
}

export type WorktreeTabSettleTracker = {
  /** Feeds one poll in and returns how many consecutive agreeing observations have accrued. */
  observe(observation: WorktreeTabObservation): number
  /** The most recent observation. */
  latest(): WorktreeTabObservation
}

export function createWorktreeTabSettleTracker(
  options: WorktreeTabSettleOptions
): WorktreeTabSettleTracker {
  // Why null and not '': every observation has a key, so no first poll can agree with the seed.
  let previousKey: string | null = null
  let agreements = 0
  let latest: WorktreeTabObservation = { present: false }

  return {
    observe(observation) {
      latest = observation
      const key = worktreeTabObservationKey(observation)
      if (options.requirePresentRow && !observation.present) {
        // Not an answer, so it cannot accrue agreement — but it is still what we last saw, so a
        // row that appears next poll reads as a change rather than as more of the same.
        previousKey = key
        agreements = 0
        return 0
      }
      agreements = key === previousKey ? agreements + 1 : 0
      previousKey = key
      return agreements
    },
    latest() {
      return latest
    }
  }
}
