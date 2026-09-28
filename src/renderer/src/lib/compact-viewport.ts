import { useSyncExternalStore } from 'react'

/** Below Tailwind's `md`: a phone in portrait, where side-by-side panes leave no usable center. */
export const COMPACT_VIEWPORT_QUERY = '(max-width: 767px)'

function compactMedia(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  return window.matchMedia(COMPACT_VIEWPORT_QUERY)
}

export function isCompactViewport(): boolean {
  return compactMedia()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const media = compactMedia()
  if (!media) {
    return () => {}
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}

export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, isCompactViewport, () => false)
}
