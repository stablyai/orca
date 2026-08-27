import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

// Why: terminal panes can number in the hundreds, but OS reduced-motion is one
// browser signal. Share a single media listener instead of one per pane.
const subscribers = new Set<() => void>()
let mediaQueryList: MediaQueryList | null = null
let unsubscribeMediaQuery: (() => void) | null = null
let hasSnapshot = false
let snapshot = false

function readMediaQueryList(): MediaQueryList | null {
  if (mediaQueryList) {
    return mediaQueryList
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY)
  return mediaQueryList
}

function refreshSnapshot(): void {
  snapshot = readMediaQueryList()?.matches ?? false
  hasSnapshot = true
}

export function getPrefersReducedMotionSnapshot(): boolean {
  if (!hasSnapshot) {
    refreshSnapshot()
  }
  return snapshot
}

export function subscribeToPrefersReducedMotionChange(onChange: () => void): () => void {
  subscribers.add(onChange)
  if (!unsubscribeMediaQuery) {
    const media = readMediaQueryList()
    if (media) {
      snapshot = media.matches
      hasSnapshot = true
      const handleChange = (event: MediaQueryListEvent): void => {
        snapshot = event.matches
        for (const subscriber of subscribers) {
          subscriber()
        }
      }
      media.addEventListener('change', handleChange)
      unsubscribeMediaQuery = () => media.removeEventListener('change', handleChange)
    }
  }
  return () => {
    subscribers.delete(onChange)
    if (subscribers.size > 0) {
      return
    }
    unsubscribeMediaQuery?.()
    unsubscribeMediaQuery = null
    mediaQueryList = null
    hasSnapshot = false
  }
}

/** Live reduced-motion preference for terminal cursor blink and settings preview. */
export function usePrefersReducedMotionLive(): boolean {
  return useSyncExternalStore(
    subscribeToPrefersReducedMotionChange,
    getPrefersReducedMotionSnapshot,
    () => false
  )
}

export function resetPrefersReducedMotionSubscriptionForTests(): void {
  unsubscribeMediaQuery?.()
  subscribers.clear()
  mediaQueryList = null
  unsubscribeMediaQuery = null
  hasSnapshot = false
  snapshot = false
}
