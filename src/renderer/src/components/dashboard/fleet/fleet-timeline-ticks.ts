import type { FleetView } from './fleet-view-model'

const MINUTE_MS = 60_000
const DAY_MINUTES = 1440
const STEP_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, DAY_MINUTES] as const
const MAX_TICK_GAPS = 4

export type FleetTimelineTick = { minutesAgo: number; percent: number }

/** Ticks count back from now in a round step, so the last tick is always "now". */
export function buildFleetTimelineTicks(window: FleetView['window']): FleetTimelineTick[] {
  const span = window.to - window.from
  if (span <= 0) {
    return [{ minutesAgo: 0, percent: 100 }]
  }
  const spanMinutes = span / MINUTE_MS
  const step =
    STEP_MINUTES.find((minutes) => spanMinutes / minutes <= MAX_TICK_GAPS) ??
    Math.ceil(spanMinutes / MAX_TICK_GAPS / DAY_MINUTES) * DAY_MINUTES
  const ticks: FleetTimelineTick[] = []
  for (let minutesAgo = 0; minutesAgo <= spanMinutes; minutesAgo += step) {
    ticks.push({ minutesAgo, percent: 100 - ((minutesAgo * MINUTE_MS) / span) * 100 })
  }
  return ticks
}

export function fleetTimelinePercent(window: FleetView['window'], at: number): number {
  const span = window.to - window.from
  return span <= 0 ? 100 : ((at - window.from) / span) * 100
}
