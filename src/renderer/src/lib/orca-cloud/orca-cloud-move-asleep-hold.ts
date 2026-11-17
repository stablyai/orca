// "Move to this computer" on an asleep workspace: the move has to wake it to pack it, but its page
// stays on the asleep view (showing the move) instead of switching to the live workspace, until the
// move has put it back to sleep (or archived it).
import { useSyncExternalStore } from 'react'

const held = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

export function holdMovingAsleep(workspaceId: string): void {
  if (!held.has(workspaceId)) {
    held.add(workspaceId)
    emit()
  }
}

export function releaseMovingAsleep(workspaceId: string): void {
  if (held.delete(workspaceId)) {
    emit()
  }
}

export function useIsMovingAsleep(workspaceId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => held.has(workspaceId),
    () => false
  )
}
