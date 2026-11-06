/** The one current observation of each held host launch, which owns every wait it can remove: its
 *  status and release waits, its retry delays and its parked preparation's Retry. Ending it (Close,
 *  the launch's retirement, a newer observation) detaches all of them at once; a request already
 *  sent may still finish under its own deadline, and its answer is then ignored. Ending an
 *  observation never ends the launch's input: that has its own owner. */

export type HostLaunchObserver = {
  readonly signal: AbortSignal
  /** Set while its message's files could not reach the host; an explicit Retry calls it. */
  resume?: () => void
}

const observers = new Map<string, HostLaunchObserver & { abort: AbortController }>()

/** Starts the launch's observation, ending any earlier one of it. */
export function beginHostLaunchObservation(sessionId: string): HostLaunchObserver {
  endHostLaunchObservation(sessionId)
  const abort = new AbortController()
  const observer = { abort, signal: abort.signal }
  observers.set(sessionId, observer)
  return observer
}

/** Ends the launch's current observation, or only `observer` when given: an older one's late
 *  finish never ends a newer one's. */
export function endHostLaunchObservation(sessionId: string, observer?: HostLaunchObserver): void {
  const current = observers.get(sessionId)
  if (!current || (observer && observer !== current)) {
    return
  }
  observers.delete(sessionId)
  delete current.resume
  current.abort.abort()
}

export function currentHostLaunchObserver(sessionId: string): HostLaunchObserver | undefined {
  return observers.get(sessionId)
}

export function resetHostLaunchObserversForTests(): void {
  for (const sessionId of observers.keys()) {
    endHostLaunchObservation(sessionId)
  }
}
