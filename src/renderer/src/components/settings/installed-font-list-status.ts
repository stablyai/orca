import { useSyncExternalStore } from 'react'

// One font list backs every font picker, so its availability is shared too.
let installedFontsUnavailable = false
const listeners = new Set<() => void>()

export function setInstalledFontsUnavailable(unavailable: boolean): void {
  if (installedFontsUnavailable === unavailable) {
    return
  }
  installedFontsUnavailable = unavailable
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
