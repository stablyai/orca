export function structuredAgentSessionStopControl(input: {
  published: boolean
  /** Temporary: hosts without create.message.v1 still leave the prompt on this client. */
  legacyLaunch?: { takeBackText: () => void }
  host: {
    /** The host takes a Stop naming no turn (and this view holds its fence). */
    stopsConversation: boolean
    stop: (turnId: string | null, stopSends: () => void) => Promise<unknown>
  }
  transportState: { turnId: string | null; isWorking: boolean }
  sends: {
    sending: boolean
    /** A Stop's part of that send: what has not gone out goes no further. */
    stopSends: () => void
  }
}): { canStop: boolean; stop: () => Promise<unknown> } {
  const { published, host, legacyLaunch } = input
  const { turnId, isWorking } = input.transportState
  const { sending, stopSends } = input.sends
  return {
    canStop: published
      ? turnId !== null || (host.stopsConversation && (isWorking || sending))
      : legacyLaunch !== undefined && sending,
    stop: () => {
      if (!published) {
        if (legacyLaunch) {
          legacyLaunch.takeBackText()
          stopSends()
        }
        return Promise.resolve(null)
      }
      return host.stop(turnId, stopSends)
    }
  }
}
