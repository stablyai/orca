let latestNavigationIntent = 0
const navigationIntentListeners = new Set<() => void>()

export function beginNavigationIntent(): number {
  latestNavigationIntent += 1
  for (const listener of navigationIntentListeners) {
    listener()
  }
  return latestNavigationIntent
}

export function getCurrentNavigationIntent(): number {
  return latestNavigationIntent
}

export function isCurrentNavigationIntent(intent: number): boolean {
  return intent === latestNavigationIntent
}

export function subscribeNavigationIntent(listener: () => void): () => void {
  navigationIntentListeners.add(listener)
  return () => navigationIntentListeners.delete(listener)
}
