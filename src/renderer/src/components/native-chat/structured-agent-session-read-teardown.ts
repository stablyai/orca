export function teardownStructuredReadOwner(
  activations: Set<symbol>,
  listeners: Set<() => void>,
  stop: () => void
): void {
  const pending = [...listeners]
  activations.clear()
  listeners.clear()
  try {
    stop()
  } finally {
    for (const listener of pending) {
      try {
        listener()
      } catch (error) {
        console.warn('[native-chat] reader end observer failed', error)
      }
    }
  }
}
