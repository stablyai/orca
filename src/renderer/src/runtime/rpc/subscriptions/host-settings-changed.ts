type HostSettingsChangedListener = (environmentId: string, keys: readonly string[]) => void

const listeners = new Set<HostSettingsChangedListener>()

/** A paired host's `settingsChanged` event, for views that show that host's settings while open. */
export function subscribeHostSettingsChanged(listener: HostSettingsChangedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyHostSettingsChanged(environmentId: string, keys: readonly string[]): void {
  for (const listener of listeners) {
    try {
      listener(environmentId, keys)
    } catch (error) {
      console.warn('[settings] host settings listener failed', error)
    }
  }
}
