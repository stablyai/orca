import { useSyncExternalStore } from 'react'

type Listener = () => void

let currentNow = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<Listener>()

function publishTick(): void {
  currentNow = Date.now()
  for (const listener of listeners) {
    listener()
  }
}

export function subscribePromptCacheCountdownClock(listener: Listener): () => void {
  listeners.add(listener)
  // Why: the clock only runs while a countdown is visible. Refresh immediately
  // on subscribe so a card mounted after a long idle period does not render a
  // stale module-load timestamp for one second.
  currentNow = Date.now()
  listener()
  if (timer === null) {
    timer = setInterval(publishTick, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

function getPromptCacheCountdownNow(): number {
  return currentNow
}

function subscribeInactivePromptCacheCountdown(): () => void {
  return () => {}
}

function getInactivePromptCacheCountdownNow(): number {
  return 0
}

export function usePromptCacheCountdownNow(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribePromptCacheCountdownClock : subscribeInactivePromptCacheCountdown,
    active ? getPromptCacheCountdownNow : getInactivePromptCacheCountdownNow,
    active ? getPromptCacheCountdownNow : getInactivePromptCacheCountdownNow
  )
}
