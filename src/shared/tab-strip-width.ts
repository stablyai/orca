export const TAB_DEFAULT_WIDTH = 330
export const TAB_MIN_WIDTH = 144
export const TAB_MAX_WIDTH = 640
export const TAB_RESIZE_KEYBOARD_STEP = 16
// Bounds the persisted map: closed tabs are never pruned, so the oldest resizes fall off.
export const TAB_WIDTHS_MAX_ENTRIES = 500

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function clampTabWidth(width: number): number {
  return Math.round(Math.min(TAB_MAX_WIDTH, Math.max(TAB_MIN_WIDTH, width)))
}

function isTabWidthKey(key: string): boolean {
  return key.length > 0 && !RESERVED_KEYS.has(key)
}

/** Drops malformed entries, clamps widths and keeps the most recently written entries. */
export function normalizeTabWidthsById(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      isTabWidthKey(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])
  )
  return Object.fromEntries(
    entries
      .slice(-TAB_WIDTHS_MAX_ENTRIES)
      .map(([tabId, width]) => [tabId, clampTabWidth(width)] as const)
  )
}

/** Per-tab patch: a width sets that tab, null resets it, absent tabs are untouched. */
export type TabWidthChanges = Record<string, number | null>

/** Applies a patch per tab so concurrent clients resizing different tabs cannot erase each other. */
export function applyTabWidthChanges(widths: unknown, changes: unknown): Record<string, number> {
  let next = normalizeTabWidthsById(widths)
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    return next
  }
  for (const [tabId, width] of Object.entries(changes)) {
    if (width === null || (typeof width === 'number' && Number.isFinite(width))) {
      next = withTabWidth(next, tabId, width)
    }
  }
  return next
}

/** Re-inserts `tabId` last so trimming evicts least recently resized tabs; null restores the default width. */
export function withTabWidth(
  widths: Readonly<Record<string, number>>,
  tabId: string,
  width: number | null
): Record<string, number> {
  if (!isTabWidthKey(tabId)) {
    return { ...widths }
  }
  const next = { ...widths }
  delete next[tabId]
  if (width === null) {
    return next
  }
  next[tabId] = clampTabWidth(width)
  return normalizeTabWidthsById(next)
}
