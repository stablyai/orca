import { useSyncExternalStore } from 'react'

// The right sidebar's Background panel owns this node; the active chat portals its tasks into it.
let target: HTMLElement | null = null
const listeners = new Set<() => void>()

export function setZotzBackgroundPanelTarget(next: HTMLElement | null): void {
  if (target === next) {
    return
  }
  target = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useZotzBackgroundPanelTarget(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => target)
}
