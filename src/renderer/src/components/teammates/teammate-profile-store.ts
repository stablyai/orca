// Which teammate's profile is open (one at a time). Entry points: a teammate's avatar on a cloud
// workspace row, their row on the Team page, and a poke toast.
import { useSyncExternalStore } from 'react'

let openUserId: string | null = null
const listeners = new Set<() => void>()

function set(next: string | null): void {
  openUserId = next
  for (const listener of listeners) {
    listener()
  }
}

export function openTeammateProfile(userId: string): void {
  set(userId)
}

export function closeTeammateProfile(): void {
  set(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useOpenTeammateProfile(): string | null {
  return useSyncExternalStore(subscribe, () => openUserId)
}
