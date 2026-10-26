import { useSyncExternalStore } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'

type Listener = () => void

let currentNow = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
let stopVisibilityWatcher: (() => void) | null = null
const listeners = new Set<Listener>()

function publishTick(): void {
  currentNow = Date.now()
  for (const listener of listeners) {
    listener()
  }
}

function stopTimer(): void {
  if (timer === null) {
    return
  }
  clearInterval(timer)
  timer = null
}

function startTimer(): void {
  if (timer !== null || !isWindowVisible()) {
    return
  }
  timer = setInterval(publishTick, 1000)
}

function reconcileVisibility(): void {
  if (isWindowVisible()) {
    publishTick()
    startTimer()
  } else {
    stopTimer()
  }
}

function startClock(): void {
  if (stopVisibilityWatcher !== null) {
    return
  }
  startTimer()
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', reconcileVisibility)
    stopVisibilityWatcher = () => {
      document.removeEventListener('visibilitychange', reconcileVisibility)
    }
  } else {
    stopVisibilityWatcher = () => {}
  }
}

function stopClock(): void {
  stopTimer()
  stopVisibilityWatcher?.()
  stopVisibilityWatcher = null
}

export function subscribePromptCacheCountdownClock(listener: Listener): () => void {
  listeners.add(listener)
  // Refresh on subscribe so a visible countdown never starts from a stale idle timestamp.
  currentNow = Date.now()
  listener()
  startClock()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopClock()
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
