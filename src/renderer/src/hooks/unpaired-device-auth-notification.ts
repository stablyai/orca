type UnpairedDeviceAuthNotificationApi = {
  consumePendingUnpairedDeviceAuthFailure?: () => Promise<boolean>
  onUnpairedDeviceAuthFailure?: (callback: () => void) => () => void
}

export function subscribeToUnpairedDeviceAuthNotification(
  api: UnpairedDeviceAuthNotificationApi | undefined,
  onNotification: () => void
): () => void {
  const consume = (notifyIfUnavailable: boolean): void => {
    if (!api?.consumePendingUnpairedDeviceAuthFailure) {
      if (notifyIfUnavailable) {
        onNotification()
      }
      return
    }
    void api
      .consumePendingUnpairedDeviceAuthFailure()
      .then((pending) => {
        if (pending) {
          onNotification()
        }
      })
      .catch(() => {
        if (notifyIfUnavailable) {
          onNotification()
        }
      })
  }

  const unsubscribe = api?.onUnpairedDeviceAuthFailure?.(() => consume(true)) ?? (() => {})
  // Why: main may reach the throttle while the renderer is still mounting; pull that retained one-shot after subscribing.
  consume(false)

  // Why: an in-flight true result has already consumed main's one-shot, so cleanup detaches events but lets that claim finish (including StrictMode remounts).
  return unsubscribe
}
