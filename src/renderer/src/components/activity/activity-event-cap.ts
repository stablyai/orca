import type { ActivityEvent } from './activity-thread-types'

// Cap each pane’s history so one busy pane cannot crowd out others; export the bound to skip unused history construction.
export const EVENTS_PER_PANE_CAP = 5

export function capActivityEvents(events: ActivityEvent[]): ActivityEvent[] {
  // Live turns already have uncapped snapshots; they must not evict retained history.
  const working = events.filter((event) => event.state === 'working')
  const sorted = events
    .filter((event) => event.state !== 'working')
    .sort((a, b) => b.observedAt - a.observedAt)
  const perPaneCount = new Map<string, number>()
  const includedEventIds = new Set<string>()
  const capped: ActivityEvent[] = []
  // Reserve one newest event per pane before filling the 80-event budget; otherwise long histories can hide whole panes.
  for (const event of sorted) {
    const paneKey = event.entry.paneKey
    if (perPaneCount.has(paneKey)) {
      continue
    }
    if (capped.length >= 80) {
      break
    }
    perPaneCount.set(paneKey, 1)
    includedEventIds.add(event.id)
    capped.push(event)
  }
  for (const event of sorted) {
    if (includedEventIds.has(event.id)) {
      continue
    }
    if (capped.length >= 80) {
      break
    }
    const paneKey = event.entry.paneKey
    const count = perPaneCount.get(paneKey) ?? 0
    if (count >= EVENTS_PER_PANE_CAP) {
      continue
    }
    perPaneCount.set(paneKey, count + 1)
    includedEventIds.add(event.id)
    capped.push(event)
  }
  return [...capped, ...working].sort((a, b) => b.observedAt - a.observedAt)
}
