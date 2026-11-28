const listeners = new Set<() => void>()

/** Tells open Settings rows that an install or removal finished elsewhere, so they re-read disk. */
export function notifyAgentHookStatusesChanged(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function onAgentHookStatusesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
