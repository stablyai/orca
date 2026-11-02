export const TAB_DEFAULT_WIDTH = 330
export const TAB_MIN_WIDTH = 144
export const TAB_MAX_WIDTH = 640
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
