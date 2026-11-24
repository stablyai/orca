import { useEffect, useState } from 'react'

export function readMediaQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMediaQuery(query))

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const media = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])

  return matches
}
