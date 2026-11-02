// Whether a structured chat offers Stop, and what Stop does, from what this view knows of the chat.

export function structuredAgentSessionStopControl(input: {
  /** The host has published this chat to this view. */
  published: boolean
  /** Temporary: hosts without create.message.v1 still leave the prompt on this client. */
  legacyLaunch?: { takeBackText: () => void }
  /** The Stop the host is asked for once it has published this chat. */
  host: {
    /** The host takes a Stop naming no turn (and this view holds its fence). */
    stopsConversation: boolean
    stop: (turnId: string | null, stopSends: () => void) => Promise<unknown>
  }
  transportState: { turnId: string | null; isWorking: boolean }
  sends: {
    /** The chat's one send is out and unsettled. */
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
