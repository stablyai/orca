// Whether a structured chat offers Stop, and what Stop does, from what this view knows of the chat.

export function structuredAgentSessionStopControl(input: {
  /** The host has published this chat to this view. */
  published: boolean
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
    /** Before the host publishes the chat: the launch's unsent text goes back to the composer. */
    takeBackLaunchText: () => void
  }
}): { canStop: boolean; stop: () => Promise<unknown> } {
  const { published, host } = input
  const { turnId, isWorking } = input.transportState
  const { sending, stopSends, takeBackLaunchText } = input.sends
  return {
    // Before the host publishes this chat to this view, nothing sent has reached it: a Stop takes
    // back what this client holds, so a start that never answers cannot hold the message hostage.
    canStop:
      turnId !== null ||
      (!published && sending) ||
      (host.stopsConversation && (isWorking || sending)),
    stop: () => {
      if (!published) {
        takeBackLaunchText()
        stopSends()
        return Promise.resolve(null)
      }
      return host.stop(turnId, stopSends)
    }
  }
}
