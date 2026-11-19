import { useSyncExternalStore } from 'react'

// One app-wide position: people slide the palette off their own site's header, which sits in the same place on every page.
const STORAGE_KEY = 'orca.browser.annotate-palette-position'
const DEFAULT_RATIO = 0.5

let cachedRatio: number | null = null
const listeners = new Set<() => void>()

function readStoredRatio(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? Number.NaN : Number.parseFloat(raw)
    return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

export function getAnnotatePaletteRatio(): number {
  cachedRatio ??= readStoredRatio()
  return cachedRatio
}

export function setAnnotatePaletteRatio(ratio: number): void {
  const next = Math.min(1, Math.max(0, ratio))
  if (next === getAnnotatePaletteRatio()) {
    return
  }
  cachedRatio = next
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next))
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

/** The saved palette position as a 0–1 fraction of its free travel (0.5 = centre). */
export function useAnnotatePaletteRatio(): number {
  return useSyncExternalStore(subscribe, getAnnotatePaletteRatio, getAnnotatePaletteRatio)
}
