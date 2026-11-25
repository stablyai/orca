/** Only targeted Stops are joinable; untargeted presses stop whatever is running when each reaches the host. */
export function structuredAgentSessionStopIsJoinable(
  fingerprintMethod: string,
  fields: Record<string, unknown>
): boolean {
  if (fingerprintMethod !== 'agentSession.cancel') {
    return false
  }
  return fields.scope === 'background-tasks'
    ? fields.taskId !== undefined
    : fields.turnId !== undefined
}

/** Older hosts lack quiet repeated Stops: a repeat joins the in-flight Stop instead of sending again. */
export function joinStructuredAgentSessionStop<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  stop: () => Promise<T>
): Promise<T> {
  const joined = inFlight.get(key)
  if (joined) {
    return joined
  }
  const stopping = stop()
  inFlight.set(key, stopping)
  // Gone once it settles, so the next press is a new Stop.
  void stopping.finally(() => {
    if (inFlight.get(key) === stopping) {
      inFlight.delete(key)
    }
  })
  return stopping
}
