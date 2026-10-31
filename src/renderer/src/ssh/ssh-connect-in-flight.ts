import { useCallback, useSyncExternalStore } from 'react'

// Store connecting status arrives one IPC hop late. Share target-keyed locks across surfaces to prevent duplicate credential prompts; acquisition IDs keep late releases from clearing newer locks.
const inFlightLockIds = new Map<string, number>()
let lastLockId = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeSshConnectInFlight(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function acquire(targetId: string): number {
  const held = inFlightLockIds.get(targetId)
  if (held !== undefined) {
    return held
  }
  lastLockId += 1
  inFlightLockIds.set(targetId, lastLockId)
  emit()
  return lastLockId
}

function releaseOwned(targetId: string, lockId: number): void {
  if (inFlightLockIds.get(targetId) !== lockId) {
    return
  }
  inFlightLockIds.delete(targetId)
  emit()
}

export function beginSshConnect(targetId: string): void {
  acquire(targetId)
}

export function endSshConnect(targetId: string): void {
  if (!inFlightLockIds.delete(targetId)) {
    return
  }
  emit()
}

export function isSshConnectInFlight(targetId: string): boolean {
  return inFlightLockIds.has(targetId)
}

/** Hold until backend request settles, surviving component unmount/display timeout; releasing on UI timeout permits duplicate credential prompts. */
export function trackSshConnect<T>(targetId: string, request: Promise<T>): Promise<T> {
  const lockId = acquire(targetId)
  const release = (): void => {
    releaseOwned(targetId, lockId)
  }
  // Two-arg then, not finally: a derived rejected promise here would go unhandled.
  void request.then(release, release)
  return request
}

export function useSshConnectInFlight(targetId: string): boolean {
  const getSnapshot = useCallback(() => inFlightLockIds.has(targetId), [targetId])
  return useSyncExternalStore(subscribeSshConnectInFlight, getSnapshot, getSnapshot)
}

/** Reset module registry between tests; old pending requests release only their cleared acquisition, never the next case’s lock. */
export function resetSshConnectInFlightForTests(): void {
  inFlightLockIds.clear()
  emit()
}
