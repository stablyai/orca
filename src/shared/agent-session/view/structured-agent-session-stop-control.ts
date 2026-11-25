/** A published chat: its running turn, or the whole conversation where the host stops that while working or sending. */
export function structuredAgentSessionCanStop(input: {
  turnId: string | null
  isWorking: boolean
  sending: boolean
  stopsConversation: boolean
}): boolean {
  return input.turnId !== null || (input.stopsConversation && (input.isWorking || input.sending))
}

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
      ? structuredAgentSessionCanStop({
          turnId,
          isWorking,
          sending,
          stopsConversation: host.stopsConversation
        })
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
