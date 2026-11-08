type EphemeralVmRuntimesChangedListener = () => void
const runtimesChangedListeners = new Set<EphemeralVmRuntimesChangedListener>()

/** Lets UI owners mirror lifecycle status (suspend, resume, cleanup) without polling the file. */
export function onEphemeralVmRuntimesChanged(
  listener: EphemeralVmRuntimesChangedListener
): () => void {
  runtimesChangedListeners.add(listener)
  return () => runtimesChangedListeners.delete(listener)
}

export function notifyEphemeralVmRuntimesChanged(): void {
  for (const listener of runtimesChangedListeners) {
    try {
      listener()
    } catch {
      // A UI mirror must never fail a durable lifecycle write.
    }
  }
}
