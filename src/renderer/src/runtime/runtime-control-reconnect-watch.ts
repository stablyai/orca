/**
 * Watches one environment's shared control connection for a reconnect (not-ready → ready), so a
 * create whose reply was lost can replay once the host is reachable again instead of failing
 * against a network that is still down.
 */
export type RuntimeControlReconnectWatch = {
  /** Resolves true once a reconnect has happened since the watch began, false after the bound. */
  reconnected: (timeoutMs: number) => Promise<boolean>
  dispose: () => void
}

export function watchRuntimeControlReconnect(environmentId: string): RuntimeControlReconnectWatch {
  // Why assume ready: every reopen publishes awaiting_ready first, so no reconnect goes unseen,
  // while ready republished on a socket that is silently dead does not count.
  let lastState = 'ready'
  let reconnects = 0
  const waiters = new Set<(value: boolean) => void>()
  const unsubscribe = window.api?.runtimeEnvironments?.onSharedControlDiagnostics?.((event) => {
    if (event.environmentId !== environmentId) {
      return
    }
    const state = event.diagnostics.state
    if (state === 'ready' && lastState !== 'ready') {
      reconnects += 1
      for (const resolve of waiters) {
        resolve(true)
      }
    }
    lastState = state
  })
  return {
    reconnected: (timeoutMs) => {
      if (reconnects > 0 || !unsubscribe) {
        return Promise.resolve(reconnects > 0)
      }
      return new Promise((resolve) => {
        const finish = (value: boolean): void => {
          clearTimeout(timer)
          waiters.delete(finish)
          resolve(value)
        }
        const timer = setTimeout(() => finish(false), timeoutMs)
        waiters.add(finish)
      })
    },
    dispose: () => {
      unsubscribe?.()
      for (const resolve of waiters) {
        resolve(false)
      }
    }
  }
}
