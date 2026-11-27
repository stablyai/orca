import { useEffect } from 'react'

const listeners = new Set<() => void>()

/** Right-click on the rail opens its "…" menu (Customize, or More when the rail folds). */
export function requestAppRailMenu(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function useAppRailMenuRequest(onRequest: () => void): void {
  useEffect(() => {
    listeners.add(onRequest)
    return () => {
      listeners.delete(onRequest)
    }
  }, [onRequest])
}
