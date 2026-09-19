/**
 * At-most-once reservation for a notification event that has its own identity.
 *
 * Distinct from the burst cooldown beside it, which answers "has this workspace been noisy
 * lately" and expires on a timer. An event identity does not expire: the same completion is the
 * same completion an hour later, so a time window would let a slow second window raise it twice.
 *
 * Bounded by count rather than by age, and insertion-ordered so eviction drops the oldest. The
 * only thing eviction can cost is a duplicate for an event that was already announced and has
 * since had this many newer events behind it, which no real sequence reaches.
 */
const MAX_REMEMBERED_EVENTS = 256

export function reserveNotificationEventOnce(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) {
    return false
  }
  seen.add(key)
  while (seen.size > MAX_REMEMBERED_EVENTS) {
    const oldest = seen.values().next()
    if (oldest.done) {
      break
    }
    seen.delete(oldest.value)
  }
  return true
}
