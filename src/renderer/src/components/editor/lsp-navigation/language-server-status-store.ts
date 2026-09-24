// Pure store for the language-server status surface (spec §6): the transient
// `$/progress` projection and the persistent degraded hint. Framework-free and
// cycle-free so both the React status bar and the IPC subscriber can import it
// without a circular dependency. Toast routing (LRU eviction) lives in the
// subscriber, which owns the sonner import.
export type LanguageServerStatusState = {
  /** Transient `$/progress` projection; null when idle (cleared on `end`). */
  progress: string | null
  /** Persistent degraded hint (no clangd / version too low); null when fine. */
  degraded: string | null
}

type Listener = (state: LanguageServerStatusState) => void

const state: LanguageServerStatusState = { progress: null, degraded: null }
const listeners = new Set<Listener>()

function notify(): void {
  for (const listener of listeners) {
    listener({ ...state })
  }
}

/** Set the transient progress projection; null clears it. */
export function setLanguageServerProgress(text: string | null): void {
  state.progress = text
  notify()
}

/** Set the persistent degraded hint; null clears it. */
export function setLanguageServerDegraded(message: string | null): void {
  state.degraded = message
  notify()
}

/** Read the current status snapshot (immutable copy). */
export function getLanguageServerStatus(): LanguageServerStatusState {
  return { ...state }
}

/** Subscribe to status changes; returns an unsubscribe function. */
export function subscribeLanguageServerStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reset the store for unit tests. */
export function resetLanguageServerStatusForTests(): void {
  state.progress = null
  state.degraded = null
  listeners.clear()
}
