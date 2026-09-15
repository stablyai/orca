/** Dispatch heartbeat freshness: the agent still reporting on the orchestration protocol.
 *  Complementary to `FleetLiveness`, which reads `agent_status`/the execution host to decide
 *  whether the *process* is alive. A live process whose agent stopped reporting is exactly the
 *  lane a coordinator loses, and neither signal can be derived from the other. */

// Why: 10 min = documented heartbeat cadence (5 min) x 2, so one missed heartbeat is the earliest
// a Dispatch can look stale. Shared with warnStaleDispatches so both surfaces agree on the word.
export const DISPATCH_HEARTBEAT_STALE_AFTER_MS = 10 * 60 * 1000

/** What this host holds for the arrival stamp: epoch ms, `null` when the Dispatch never reported,
 *  or `unreadable` when a value is stored that no parser accepts. The third case is kept apart
 *  from `null` so a corrupt row cannot be published as silence. */
export type DispatchHeartbeatStamp = number | null | 'unreadable'

export type FleetHeartbeat = {
  /** `none` = this Dispatch has never reported; `unreadable` = a stored stamp this host cannot
   *  parse, which is corruption rather than silence. Neither is a claim about the process. */
  state: 'none' | 'fresh' | 'stale' | 'unreadable'
  /** Epoch ms at which this host recorded the heartbeat, never a stamp the worker chose. */
  lastReceivedAt: number | null
  ageSeconds: number | null
}

/** `lastReceivedAt` is arrival time on the Run home, so the age is a single-clock subtraction. */
export function projectDispatchHeartbeat(
  lastReceivedAt: DispatchHeartbeatStamp,
  now: number
): FleetHeartbeat {
  if (lastReceivedAt === 'unreadable') {
    return { state: 'unreadable', lastReceivedAt: null, ageSeconds: null }
  }
  if (lastReceivedAt === null) {
    return { state: 'none', lastReceivedAt: null, ageSeconds: null }
  }
  const ageMs = now - lastReceivedAt
  const rounded = Math.round(ageMs / 1000)
  // Round the subtraction, never the operands: a stamp ahead of this host's clock stays visible
  // as a negative age instead of collapsing into a reassuring "just reported" zero. A sub-second
  // lead rounds to `-0`, which JSON publishes as `0`, so the future branch floors at one second.
  return {
    state: ageMs > DISPATCH_HEARTBEAT_STALE_AFTER_MS ? 'stale' : 'fresh',
    lastReceivedAt,
    ageSeconds: ageMs < 0 ? Math.min(-1, rounded) : rounded
  }
}

/** Short age for a projected heartbeat: `43s` / `2m` / `3h`. Floored, and the sign survives, so a
 *  stamp ahead of this host's clock cannot read as a reassuring "just reported". */
export function formatDispatchHeartbeatAge(ageSeconds: number): string {
  const sign = ageSeconds < 0 ? '-' : ''
  const seconds = Math.abs(ageSeconds)
  if (seconds < 60) {
    return `${sign}${seconds}s`
  }
  if (seconds < 3_600) {
    return `${sign}${Math.floor(seconds / 60)}m`
  }
  return `${sign}${Math.floor(seconds / 3_600)}h`
}
