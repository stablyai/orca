import type { ActivityEvent } from './activity-thread-types'

// Why: per-pane cap guarantees each agent appears in the left list even when one pane has a long history.
// Exported so the event builder can skip building history entries the cap would drop anyway.
export const EVENTS_PER_PANE_CAP = 5

export function capActivityEvents(events: ActivityEvent[]): ActivityEvent[] {
  const sorted = events.sort((a, b) => b.timestamp - a.timestamp)
  const perPaneCount = new Map<string, number>()
  const includedEventIds = new Set<string>()
  const capped: ActivityEvent[] = []
  // Why: reserve each pane's newest event before the global 80-event cap so the validator's >16 panes × ≥5 events can't push a pane out of the window and hide it.
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
  return capped.sort((a, b) => b.timestamp - a.timestamp)
}
