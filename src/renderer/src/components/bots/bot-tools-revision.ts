// Bumped by every change from this window, so the Tools section, Connectors and chat cards read again.
let revision = 0
const listeners = new Set<() => void>()

export function toolsRevision(): number {
  return revision
}

/** Tells every reader to look again; `changed` also drops what was read before. */
export function notifyToolReaders(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function changed(): void {
  revision += 1
  notifyToolReaders()
}

export function retryBotToolCheck(): void {
  changed()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
