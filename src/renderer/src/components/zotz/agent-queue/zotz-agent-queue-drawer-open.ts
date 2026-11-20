import { useSyncExternalStore } from 'react'

// Whether the queue board is open beside the sidebar; a window-local view state, never persisted.
let open = false
const listeners = new Set<() => void>()

export function setZotzAgentQueueDrawerOpen(next: boolean): void {
  if (open === next) {
    return
  }
  open = next
  listeners.forEach((listener) => listener())
}

export function useZotzAgentQueueDrawerOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => open
  )
}
