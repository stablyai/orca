type RefLike<T> = { current: T }

const STOPPED_SESSION_WAIT_MS = 1000
const MAX_EARLY_STOPPED_SESSION_IDS = 16

export function recordStoppedSession(
  sessionId: string,
  stoppedSessionIdsRef: RefLike<Set<string>>,
  stoppedResolversRef: RefLike<Map<string, () => void>>
): void {
  const resolver = stoppedResolversRef.current.get(sessionId)
  if (resolver) {
    stoppedResolversRef.current.delete(sessionId)
    resolver()
    return
  }

  // Why: stopped events can arrive for abandoned startup attempts that will
  // never wait on the id. Keep the early-event cache bounded across sessions.
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
  stoppedResolversRef: RefLike<Map<string, () => void>>
): Promise<void> {
  if (stoppedSessionIdsRef.current.delete(sessionId)) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      stoppedResolversRef.current.delete(sessionId)
      resolve()
    }, STOPPED_SESSION_WAIT_MS)
    stoppedResolversRef.current.set(sessionId, () => {
      window.clearTimeout(timeoutId)
      resolve()
    })
  })
}
