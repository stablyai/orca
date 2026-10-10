type RefLike<T> = { current: T }

export type StoppedSessionWaiters = Map<string, Set<() => void>>

const STOPPED_SESSION_WAIT_MS = 1000
const MAX_EARLY_STOPPED_SESSION_IDS = 16

export function recordStoppedSession(
  sessionId: string,
  stoppedSessionIdsRef: RefLike<Set<string>>,
  stoppedResolversRef: RefLike<StoppedSessionWaiters>
): void {
  const waiters = stoppedResolversRef.current.get(sessionId)
  if (waiters) {
    stoppedResolversRef.current.delete(sessionId)
    for (const resolve of waiters) {
      resolve()
    }
  }

  // Why: cached even after waking waiters so later ones resolve at once; bounded for abandoned startups.
  stoppedSessionIdsRef.current.delete(sessionId)
  stoppedSessionIdsRef.current.add(sessionId)
  while (stoppedSessionIdsRef.current.size > MAX_EARLY_STOPPED_SESSION_IDS) {
    const oldest = stoppedSessionIdsRef.current.values().next().value
    if (!oldest) {
      break
    }
    stoppedSessionIdsRef.current.delete(oldest)
  }
}

export function waitForStoppedSession(
  sessionId: string,
  stoppedSessionIdsRef: RefLike<Set<string>>,
  stoppedResolversRef: RefLike<StoppedSessionWaiters>
): Promise<void> {
  // Why: kept (bounded) rather than consumed so a second waiter on the same session also resolves.
  if (stoppedSessionIdsRef.current.has(sessionId)) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    // Why: the user's stop and an error cleanup can both wait on one session; each needs the event.
    const waiters = stoppedResolversRef.current.get(sessionId) ?? new Set<() => void>()
    stoppedResolversRef.current.set(sessionId, waiters)
    const waiter = (): void => {
      window.clearTimeout(timeoutId)
      resolve()
    }
    const timeoutId = window.setTimeout(() => {
      waiters.delete(waiter)
      if (waiters.size === 0 && stoppedResolversRef.current.get(sessionId) === waiters) {
        stoppedResolversRef.current.delete(sessionId)
      }
      resolve()
    }, STOPPED_SESSION_WAIT_MS)
    waiters.add(waiter)
  })
}
