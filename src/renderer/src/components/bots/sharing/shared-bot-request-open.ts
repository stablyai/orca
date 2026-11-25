// The share request whose page is open over the main column, if any: opened from its row, closed by
// Esc, an answer, or moving to another page or workspace.
import { useSyncExternalStore } from 'react'

let openShareId: string | null = null
const listeners = new Set<() => void>()

function publish(next: string | null): void {
  if (next !== openShareId) {
    openShareId = next
    for (const listener of listeners) {
      listener()
    }
  }
}

export function openSharedBotRequest(shareId: string): void {
  publish(shareId)
}

export function closeSharedBotRequest(): void {
  publish(null)
}

export function useOpenSharedBotRequest(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => openShareId
  )
}
