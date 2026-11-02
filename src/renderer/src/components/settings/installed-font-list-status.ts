import { useSyncExternalStore } from 'react'

// Main caches the font list per process, so one failure applies to every font picker.
let installedFontsUnavailable = false
const listeners = new Set<() => void>()

export function markInstalledFontsUnavailable(): void {
  if (installedFontsUnavailable) {
    return
  }
  installedFontsUnavailable = true
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getInstalledFontsUnavailable(): boolean {
  return installedFontsUnavailable
}

export function useInstalledFontsUnavailable(): boolean {
  return useSyncExternalStore(subscribe, getInstalledFontsUnavailable)
}
