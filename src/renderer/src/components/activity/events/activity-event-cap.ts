import type { ActivityEvent } from '../threads/activity-thread-types'

// Cap each pane’s history so one busy pane cannot crowd out others; export the bound to skip unused history construction.
export const EVENTS_PER_PANE_CAP = 5

const ACTIVITY_EVENTS_CAP = 80

const newestFirst = (a: ActivityEvent, b: ActivityEvent): number => b.observedAt - a.observedAt

/** Index of each pane's first non-working event in newest-first order (earliest index on ties). */
function paneHeadIndexes(events: ActivityEvent[]): number[] {
  const heads: number[] = []
  const headSlotByPaneKey = new Map<string, number>()
  let runPaneKey: string | undefined
  let runSlot = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.state === 'working') {
      continue
    }
    // A pane's events arrive together, so the lookup runs once per pane rather than per event.
    if (event.entry.paneKey !== runPaneKey) {
      runPaneKey = event.entry.paneKey
      const slot = headSlotByPaneKey.get(runPaneKey)
      if (slot === undefined) {
        runSlot = heads.length
        headSlotByPaneKey.set(runPaneKey, runSlot)
        heads.push(index)
        continue
      }
      runSlot = slot
    }
    if (event.observedAt > events[heads[runSlot]].observedAt) {
      heads[runSlot] = index
    }
  }
  return heads
}

/** Stable merge of two newest-first lists; `first` wins ties, as in a stable sort of first ++ second. */
function mergeNewestFirst(first: ActivityEvent[], second: ActivityEvent[]): ActivityEvent[] {
  const merged: ActivityEvent[] = []
  let i = 0
  let j = 0
  while (i < first.length && j < second.length) {
    merged.push(second[j].observedAt > first[i].observedAt ? second[j++] : first[i++])
  }
  while (i < first.length) {
    merged.push(first[i++])
  }
  while (j < second.length) {
    merged.push(second[j++])
  }
  return merged
}

export function capActivityEvents(events: ActivityEvent[]): ActivityEvent[] {
  // Live turns already have uncapped snapshots; they must not evict retained history.
  const working = events.filter((event) => event.state === 'working')
  const heads = paneHeadIndexes(events)
  if (heads.length >= ACTIVITY_EVENTS_CAP) {
    // The reserve pass below fills the whole budget with the newest pane heads, so sorting only heads gives the same result.
    heads.sort((a, b) => events[b].observedAt - events[a].observedAt || a - b)
    const capped = heads.slice(0, ACTIVITY_EVENTS_CAP).map((index) => events[index])
    return mergeNewestFirst(capped, working.sort(newestFirst))
  }
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
    if (capped.length >= ACTIVITY_EVENTS_CAP) {
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
    if (capped.length >= ACTIVITY_EVENTS_CAP) {
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
  return [...capped, ...working].sort(newestFirst)
}
