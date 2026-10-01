import { normalizeWorktreeTag, worktreeTagKey } from './worktree-tags'

/** How many tag sections a manual order may pin before the rest fall back to alphabetical. */
export const MAX_MANUAL_TAG_ORDER = 256

/** Canonical manual order: normalized spellings, deduped case-insensitively, capped. */
export function normalizeManualTagOrder(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const order: string[] = []
  for (const candidate of value) {
    const tag = normalizeWorktreeTag(candidate)
    const key = worktreeTagKey(tag)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    order.push(tag)
    if (order.length >= MAX_MANUAL_TAG_ORDER) {
      break
    }
  }
  return order
}

/** Rank lookup by tag key; tags absent from the manual order rank after every listed one. */
export function getManualTagRanks(order: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>()
  normalizeManualTagOrder(order).forEach((tag, index) => {
    ranks.set(worktreeTagKey(tag), index)
  })
  return ranks
}

/**
 * Manual order after a drag: the sections the sidebar currently shows take the
 * order they were dropped into, and every tag the sidebar is not showing keeps
 * the slot it already held — so reordering a filtered view neither drops a
 * hidden tag nor pushes it to the bottom. Tags with no stored slot append.
 */
export function mergeManualTagOrder(
  storedOrder: readonly string[],
  visibleOrder: readonly string[]
): string[] {
  const stored = normalizeManualTagOrder(storedOrder)
  const dropped = normalizeManualTagOrder(visibleOrder)
  const droppedKeys = new Set(dropped.map(worktreeTagKey))
  const fill = dropped[Symbol.iterator]()
  const merged = stored.map((tag) =>
    droppedKeys.has(worktreeTagKey(tag)) ? (fill.next().value ?? tag) : tag
  )
  return normalizeManualTagOrder([...merged, ...dropped])
}
