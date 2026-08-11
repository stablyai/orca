const SCROLL_MARK_MATCH_EPSILON = 2
// Why: a bounded queue is the staleness limit. Wall-clock expiry would
// reintroduce the timing assumptions this module exists to remove. Known
// accepted window: a marked no-op write emits no scroll event, so its target
// can linger and claim a later user scroll within the epsilon; the bound and
// splice-on-match keep that window narrow.
const MAX_PENDING_SCROLL_MARKS = 16

export type ProgrammaticScrollMarks = {
  /** Register the target offset of a scroll write this code is about to make. */
  mark: (targetOffset: number) => void
  /**
   * Classify a scroll event: true when it matches a registered write (or its
   * browser-clamped landing spot). Idempotent per Event so multiple listeners
   * on the same element agree on the classification.
   */
  consume: (event: Event, scrollOffset: number, maxScrollOffset: number) => boolean
}

/**
 * Distinguishes self-initiated scrolls from user scrolls by explicit marks
 * instead of wall-clock input windows. The system always knows when it writes
 * scrollTop; it can never reliably know when the user scrolled — under
 * main-thread jank, input events dispatch late and time-window heuristics
 * misclassify exactly when it matters.
 */
export function createProgrammaticScrollMarks(): ProgrammaticScrollMarks {
  const pendingTargets: number[] = []
  const classifiedEvents = new WeakMap<Event, boolean>()

  const matchesTarget = (
    targetOffset: number,
    scrollOffset: number,
    maxScrollOffset: number
  ): boolean => {
    if (Math.abs(scrollOffset - targetOffset) <= SCROLL_MARK_MATCH_EPSILON) {
      return true
    }
    // Why: a write past the scrollable range lands at the clamped max, not at
    // its target; that landing is still our scroll, not the user's.
    return (
      targetOffset > maxScrollOffset + SCROLL_MARK_MATCH_EPSILON &&
      scrollOffset >= maxScrollOffset - SCROLL_MARK_MATCH_EPSILON
    )
  }

  return {
    mark: (targetOffset: number): void => {
      pendingTargets.push(targetOffset)
      if (pendingTargets.length > MAX_PENDING_SCROLL_MARKS) {
        pendingTargets.shift()
      }
    },
    consume: (event: Event, scrollOffset: number, maxScrollOffset: number): boolean => {
      const cached = classifiedEvents.get(event)
      if (cached !== undefined) {
        return cached
      }
      const matchedIndex = pendingTargets.findIndex((targetOffset) =>
        matchesTarget(targetOffset, scrollOffset, maxScrollOffset)
      )
      if (matchedIndex !== -1) {
        // Why: scroll events arrive in write order; older marks whose events
        // were coalesced away must not linger to claim a later user scroll.
        pendingTargets.splice(0, matchedIndex + 1)
      }
      const isProgrammatic = matchedIndex !== -1
      classifiedEvents.set(event, isProgrammatic)
      return isProgrammatic
    }
  }
}
