/**
 * Per-PTY stall lanes for the delivery watchdog.
 *
 * Why per-PTY at all: on a machine with a hundred terminals the session-global signals the
 * watchdog started with — "any pty:data event since the last tick" and `msSinceLastAck` —
 * read healthy essentially always, so one wedged pane is invisible by arithmetic. Main
 * already keeps `lastAckAtMs` per accounting entry, so the per-PTY form costs nothing new
 * on that side.
 *
 * Deliberately store-free: `terminal-delivery-watchdog.ts` is on the freeze-report path and
 * must not drag the app store (and everything it loads) into that graph. Ownership of a
 * stalled pty is answered by `terminal-parked-pane-recovery.ts`, wired in as a watchdog dep.
 */
import type { PtyDeliveryStalledPty } from '../../../../shared/pty-renderer-delivery-health'

type StallStreak = { previous: number; ticks: number }

const parkedStreakByPty = new Map<string, StallStreak>()
const wedgedStreakByPty = new Map<string, StallStreak>()

/** Advance a sampled stall streak, restarting when its progress predicate changes. */
function advanceStreak(
  streaks: Map<string, StallStreak>,
  id: string,
  value: number,
  stalled: (previous: number) => boolean
): number {
  const streak = streaks.get(id)
  if (!streak) {
    streaks.set(id, { previous: value, ticks: 1 })
    return 1
  }
  streak.ticks = stalled(streak.previous) ? streak.ticks + 1 : 1
  streak.previous = value
  return streak.ticks
}

function retainStreaks(streaks: Map<string, StallStreak>, liveIds: Set<string>): void {
  for (const id of streaks.keys()) {
    if (!liveIds.has(id)) {
      streaks.delete(id)
    }
  }
}

/** Ids whose buffer has remained occupied for `stallTicksToHeal` ticks. A drain zeroes a pty's
 *  parked total, so "still parked" is the honest evidence that nothing consumed
 *  it — byte-cap eviction is not consumer progress. */
export function advanceParkedDeliveryStallStreaks(
  parkedCharsByPty: Record<string, number>,
  stallTicksToHeal: number
): string[] {
  retainStreaks(parkedStreakByPty, new Set(Object.keys(parkedCharsByPty)))
  const stalled: string[] = []
  for (const [ptyId, chars] of Object.entries(parkedCharsByPty)) {
    if (chars <= 0) {
      continue
    }
    if (advanceStreak(parkedStreakByPty, ptyId, chars, () => true) >= stallTicksToHeal) {
      stalled.push(ptyId)
    }
  }
  return stalled
}

/** True when main reports debt for a pty whose received total has also stopped moving for
 *  the streak — the per-PTY form of the wedge the global predicate cannot see. */
export function advanceStalledPtyStreaks(
  stalledPtys: PtyDeliveryStalledPty[] | undefined,
  receivedCharsByPty: Map<string, number>,
  stallTicksToHeal: number
): boolean {
  const stalled = stalledPtys ?? []
  retainStreaks(wedgedStreakByPty, new Set(stalled.map((entry) => entry.id)))
  let anyCrossed = false
  for (const entry of stalled) {
    const received = receivedCharsByPty.get(entry.id) ?? 0
    const ticks = advanceStreak(
      wedgedStreakByPty,
      entry.id,
      received,
      (previous) => received === previous
    )
    anyCrossed ||= ticks >= stallTicksToHeal
  }
  return anyCrossed
}

export function resetParkedDeliveryStallStreaks(): void {
  parkedStreakByPty.clear()
  wedgedStreakByPty.clear()
}
