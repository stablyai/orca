import type { SessionGridItem } from '../../../../shared/session-grid-types'
// Type-only, so the pairing with the builder costs no runtime cycle.
import type { SessionGridBucketCounts, SessionGridFilterOption } from './session-grid-items-builder'

/**
 * Caller-owned reuse cache: a card whose derived fields are unchanged keeps its
 * previous object, and an unchanged list keeps its array. Every agent-status
 * burst rebuilds the whole listing, so without this every consumer keyed on those
 * identities is invalidated ~30 times a second.
 *
 * What this does NOT buy, measured: it does not stop a card re-rendering on a burst.
 * `SortableSessionGridCard`'s memo only blocks renders pushed from the parent, and
 * each card opens its own `useShallow` bundle carrying `agentStatusByPaneKey`
 * (`session-grid-card-terminal-input.ts:16`), so a burst re-renders all N cards
 * through their own subscriptions no matter how stable the item is. Nine cards with
 * one agent working still re-render nine preview subtrees. The xterm is not
 * remounted — `terminalInput` only feeds ref assignments — so the cost is React
 * render passes, not pty reconnections. Narrowing that per-card subscription is the
 * fix, and it is not this module's job.
 *
 * What it does buy is the array identities `SortableContext`, the staged mount and the
 * page's memos key on, and item identity for anything that memoizes on the item.
 */
export type SessionGridItemReuseCache = {
  previousByTabId: Map<string, SessionGridItem>
  previousAllItems: SessionGridItem[]
  previousItems: SessionGridItem[]
  previousFilterOptions: SessionGridFilterOption[]
  previousStateCounts: SessionGridBucketCounts
}

export function createSessionGridItemReuseCache(): SessionGridItemReuseCache {
  return {
    previousByTabId: new Map(),
    previousAllItems: [],
    previousItems: [],
    previousFilterOptions: [],
    previousStateCounts: { attention: 0, working: 0, done: 0, idle: 0 }
  }
}

function sessionGridItemsEqual(
  a: readonly SessionGridItem[],
  b: readonly SessionGridItem[]
): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/**
 * Reuse by the built object's own fields rather than a hand-written field list:
 * a field a later plan adds is compared without editing this, so the worst it
 * can cost is a missed reuse — never a card showing a stale value.
 */
export function reuseSessionGridItem(
  previous: SessionGridItem | undefined,
  next: SessionGridItem
): SessionGridItem {
  if (previous === undefined) {
    return next
  }
  const keys = Object.keys(next) as (keyof SessionGridItem)[]
  if (keys.length !== Object.keys(previous).length) {
    return next
  }
  return keys.every((key) => Object.is(previous[key], next[key])) ? previous : next
}

/** Swap in the previous array when nothing in the list changed identity. */
export function reuseSessionGridItemList(
  previous: SessionGridItem[],
  next: SessionGridItem[]
): SessionGridItem[] {
  return sessionGridItemsEqual(previous, next) ? previous : next
}

/**
 * The chips are rebuilt from scratch every 33 ms, so they are compared by value and
 * the previous array handed back when nothing moved. Without this the memoized toolbar
 * re-renders on every agent-status burst even though its two chip rows are identical.
 */
export function reuseSessionGridFilterOptions(
  cache: SessionGridItemReuseCache,
  next: SessionGridFilterOption[]
): SessionGridFilterOption[] {
  const previous = cache.previousFilterOptions
  const same =
    previous.length === next.length &&
    previous.every((option, i) => {
      const candidate = next[i]
      return (
        candidate !== undefined &&
        option.id === candidate.id &&
        option.label === candidate.label &&
        option.count === candidate.count
      )
    })
  cache.previousFilterOptions = same ? previous : next
  return cache.previousFilterOptions
}

/** Same contract for the state axis: four numbers, compared by value. */
export function reuseSessionGridBucketCounts(
  cache: SessionGridItemReuseCache,
  next: SessionGridBucketCounts
): SessionGridBucketCounts {
  const previous = cache.previousStateCounts
  const same = (Object.keys(next) as (keyof SessionGridBucketCounts)[]).every(
    (bucket) => previous[bucket] === next[bucket]
  )
  cache.previousStateCounts = same ? previous : next
  return cache.previousStateCounts
}

/** Record the committed listing so the next build compares against what the UI holds. */
export function commitSessionGridItemReuse(
  cache: SessionGridItemReuseCache,
  allItems: SessionGridItem[],
  items: SessionGridItem[]
): void {
  cache.previousAllItems = allItems
  cache.previousItems = items
  cache.previousByTabId = new Map(allItems.map((item) => [item.tabId, item]))
}
