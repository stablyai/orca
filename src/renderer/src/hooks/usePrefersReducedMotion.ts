import { useEffect, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readPrefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const media = window.matchMedia(REDUCED_MOTION_QUERY)
    setPrefersReducedMotion(media.matches)
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return prefersReducedMotion
}
