type RefLike<T> = { current: T }

const STOPPED_SESSION_WAIT_MS = 1000

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
