export const SERVE_STOP_READY = 'orca:serve-stop-ready'
export const SERVE_STOP_REQUEST = 'orca:serve-stop'

export type ServeSupervisorChannel = {
  on(event: 'message', listener: (message: unknown) => void): unknown
  send?: (message: string, callback: (error: Error | null) => void) => boolean
}

export function registerServeSupervisorControl(
  channel: ServeSupervisorChannel,
  stop: () => void
): void {
  channel.on('message', (message) => {
    if (message === SERVE_STOP_REQUEST) {
      stop()
    }
  })
  try {
    channel.send?.(SERVE_STOP_READY, () => undefined)
  } catch {
    // Console signals remain available if the supervisor has disconnected.
  }
}

type ServeControlChild = {
  readonly connected: boolean
  send(message: string, callback: (error: Error | null) => void): boolean
}

/** Keep early shutdown requests until the child installs graceful quit handling. */
export function createServeStopRequest(child: ServeControlChild): {
  request(): void
  handleMessage(value: unknown): void
} {
  let ready = false
  let pending = false
  const reportError = (error: unknown): void => {
    if (error) {
      console.error('[serve] could not request graceful shutdown:', error)
    }
  }
  const send = (): void => {
    if (!ready || !pending || !child.connected) {
      return
    }
    pending = false
    try {
      child.send(SERVE_STOP_REQUEST, reportError)
    } catch (error) {
      reportError(error)
    }
  }
  return {
    request() {
      pending = true
      send()
    },
    handleMessage(value) {
      if (value === SERVE_STOP_READY) {
        ready = true
        send()
      }
    }
  }
}
