let version = 0
const listeners = new Set<() => void>()

export function getTranslationResourceVersion(): number {
  return version
}

export function advanceTranslationResourceVersion(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeTranslationResourceVersion(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
