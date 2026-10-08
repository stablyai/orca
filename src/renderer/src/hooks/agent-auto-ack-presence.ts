export function createAutoAckPresenceCheck(
  readAway: () => Promise<boolean | undefined>,
  onPresent: () => void
): { request: () => void; dispose: () => void } {
  let disposed = false
  let pending = false
  return {
    request() {
      if (disposed || pending) {
        return
      }
      pending = true
      void readAway()
        .then((away) => {
          // Unknown presence must not clear unread attention.
          if (!disposed && away === false) {
            onPresent()
          }
        })
        .catch(() => {})
        .finally(() => {
          pending = false
        })
    },
    dispose() {
      disposed = true
    }
  }
}

export function subscribeAutoAckPresenceSignals(
  onRescan: () => void,
  onInput: () => void
): () => void {
  const input = (event: Event): void => {
    if (event.isTrusted) {
      onInput()
    }
  }
  document.addEventListener('visibilitychange', onRescan)
  window.addEventListener('focus', onRescan)
  const events = ['pointerdown', 'keydown', 'pointermove'] as const
  for (const event of events) {
    window.addEventListener(event, input)
  }
  return () => {
    document.removeEventListener('visibilitychange', onRescan)
    window.removeEventListener('focus', onRescan)
    for (const event of events) {
      window.removeEventListener(event, input)
    }
  }
}
