import { useSyncExternalStore } from 'react'

// One app-wide position: people slide the palette off their own site's header, which sits in the same place on every page.
const STORAGE_KEY = 'orca.browser.annotate-palette-position'

/** Each axis is a 0–1 fraction of the palette's free travel in the page area. */
export type AnnotatePalettePosition = { x: number; y: number }

/** Top centre: where the palette first appears. */
export const DEFAULT_ANNOTATE_PALETTE_POSITION: AnnotatePalettePosition = { x: 0.5, y: 0 }

let cachedPosition: AnnotatePalettePosition | null = null
const listeners = new Set<() => void>()

function clampUnit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback
}

/** Parses a stored value; a bare number is the earlier horizontal-only position. */
export function parseAnnotatePalettePosition(raw: string | null): AnnotatePalettePosition {
  if (raw === null) {
    return DEFAULT_ANNOTATE_PALETTE_POSITION
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_ANNOTATE_PALETTE_POSITION
  }
  if (typeof parsed === 'number') {
    return { x: clampUnit(parsed, DEFAULT_ANNOTATE_PALETTE_POSITION.x), y: 0 }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_ANNOTATE_PALETTE_POSITION
  }
  const { x, y } = parsed as { x?: unknown; y?: unknown }
  return {
    x: clampUnit(x, DEFAULT_ANNOTATE_PALETTE_POSITION.x),
    y: clampUnit(y, DEFAULT_ANNOTATE_PALETTE_POSITION.y)
  }
}

function readStoredPosition(): AnnotatePalettePosition {
  try {
    return parseAnnotatePalettePosition(window.localStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_ANNOTATE_PALETTE_POSITION
  }
}

export function getAnnotatePalettePosition(): AnnotatePalettePosition {
  cachedPosition ??= readStoredPosition()
  return cachedPosition
}

export function setAnnotatePalettePosition(position: AnnotatePalettePosition): void {
  const next = { x: clampUnit(position.x, 0.5), y: clampUnit(position.y, 0) }
  const current = getAnnotatePalettePosition()
  if (next.x === current.x && next.y === current.y) {
    return
  }
  cachedPosition = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the position still holds for this session.
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The saved palette position (x 0.5 = centred, y 0 = top). */
export function useAnnotatePalettePosition(): AnnotatePalettePosition {
  return useSyncExternalStore(subscribe, getAnnotatePalettePosition, getAnnotatePalettePosition)
}
