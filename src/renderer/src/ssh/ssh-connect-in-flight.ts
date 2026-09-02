import { useCallback, useSyncExternalStore } from 'react'

// Why: the store status lags a user click by one IPC hop (main broadcasts 'connecting'
// after ssh.connect starts), and every workspace card on a host shares one connection.
// Component-local state would let two surfaces — or N cards on the same host — each fire
// a connect, which on a passphrase-gated target means N credential prompts.
// Keyed by target, valued by the id of the acquisition holding the lock: a release can then
// clear only its own acquisition, so a settle that lands after the lock was dropped (a test
// reset, an explicit end) cannot take down a newer connect's lock.
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

/**
 * Holds the lock for `request`'s whole life and returns it unchanged.
 * Why: UI callers race the request against a display timeout, but the backend keeps dialing
 * past it — releasing when the caller stops waiting would let the next click raise a second
 * credential prompt. Also survives unmount, unlike a `finally` in a component handler.
 */
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

/**
 * Test-only: the registry is module state, so specs must reset it between cases.
 * A request tracked before the reset stays pending; its release is scoped to the cleared
 * lock id, so it settles into a no-op rather than unlocking the next case's target.
 */
export function resetSshConnectInFlightForTests(): void {
  inFlightLockIds.clear()
  emit()
}
