import { useSyncExternalStore } from 'react'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

// Why: terminal panes can number in the hundreds, but OS color-scheme is one
// browser signal. Share a single media listener instead of one per pane.
const subscribers = new Set<() => void>()
let mediaQueryList: MediaQueryList | null = null
let unsubscribeMediaQuery: (() => void) | null = null
let hasSnapshot = false
let snapshot = true

function readMediaQueryList(): MediaQueryList | null {
  if (mediaQueryList) {
    return mediaQueryList
  }
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  mediaQueryList = window.matchMedia(SYSTEM_DARK_QUERY)
  return mediaQueryList
}

function refreshSnapshot(): void {
  snapshot = readMediaQueryList()?.matches ?? true
  hasSnapshot = true
}

export function getSystemPrefersDarkSnapshot(): boolean {
  if (!hasSnapshot) {
    refreshSnapshot()
  }
  return snapshot
}

export function subscribeToSystemPrefersDarkChange(onChange: () => void): () => void {
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

export function useSystemPrefersDark(): boolean {
  return useSyncExternalStore(
    subscribeToSystemPrefersDarkChange,
    getSystemPrefersDarkSnapshot,
    () => true
  )
}

export function resetSystemPrefersDarkSubscriptionForTests(): void {
  unsubscribeMediaQuery?.()
  subscribers.clear()
  mediaQueryList = null
  unsubscribeMediaQuery = null
  hasSnapshot = false
  snapshot = true
}
