// Which composers flash once for text handed in to finish, by draft scope.
import { useCallback, useSyncExternalStore } from 'react'

// The flash's length in main.css; it ends on this timer, not on animationend, so a hidden or
// reduced-motion box never keeps it for a later reveal.
export const NATIVE_CHAT_COMPOSER_GLOW_MS = 2_000

const glowing = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
let generation = 0

function notify(scopeKey: string): void {
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

export function glowNativeChatComposer(scopeKey: string): void {
  const mine = ++generation
  const start = (): void => {
    glowing.set(scopeKey, mine)
    notify(scopeKey)
    setTimeout(() => {
      if (glowing.get(scopeKey) === mine) {
        glowing.delete(scopeKey)
        notify(scopeKey)
      }
    }, NATIVE_CHAT_COMPOSER_GLOW_MS)
  }
  if (!glowing.delete(scopeKey)) {
    start()
    return
  }
  // A flash already running restarts: the box paints one frame without it first.
  notify(scopeKey)
  requestAnimationFrame(() => requestAnimationFrame(start))
}

function subscribe(scopeKey: string, listener: () => void): () => void {
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0 && listeners.get(scopeKey) === scoped) {
      listeners.delete(scopeKey)
    }
  }
}

export function useNativeChatComposerGlow(scopeKey: string): boolean {
  const subscribeScope = useCallback(
    (listener: () => void) => subscribe(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribeScope, () => glowing.has(scopeKey))
}
