const SCROLL_MARK_MATCH_EPSILON = 2
// Bound marks rather than expiring by clock; no-op writes may match later user offsets, so capacity and splice-on-match limit that accepted ambiguity.
const MAX_PENDING_SCROLL_MARKS = 16

export type ProgrammaticScrollMarks = {
  mark: (targetOffset: number) => void
  hasPendingScrollOffset: (scrollOffset: number, maxScrollOffset: number) => boolean
  /** Classify explicit target/clamped landings as programmatic; cache per Event so all listeners agree. */
  consume: (event: Event, scrollOffset: number, maxScrollOffset: number) => boolean
}

/** Mark known scroll writes instead of guessing user input from timestamps, which misclassify delayed events under main-thread jank. */
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
    // Browser-clamped max is still the landing of our out-of-range write.
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
    hasPendingScrollOffset: (scrollOffset, maxScrollOffset) =>
      pendingTargets.some((targetOffset) =>
        matchesTarget(targetOffset, scrollOffset, maxScrollOffset)
      ),
    consume: (event: Event, scrollOffset: number, maxScrollOffset: number): boolean => {
      const cached = classifiedEvents.get(event)
      if (cached !== undefined) {
        return cached
      }
      const matchedIndex = pendingTargets.findIndex((targetOffset) =>
        matchesTarget(targetOffset, scrollOffset, maxScrollOffset)
      )
      if (matchedIndex !== -1) {
        // Consume older coalesced marks in write order so they cannot claim later user scrolls.
        pendingTargets.splice(0, matchedIndex + 1)
      }
      const isProgrammatic = matchedIndex !== -1
      classifiedEvents.set(event, isProgrammatic)
      return isProgrammatic
    }
  }
}
