import { useEffect } from 'react'
import { readMediaQuery, useMediaQuery } from './use-media-query'

const REDUCED_TRANSPARENCY_QUERY = '(prefers-reduced-transparency: reduce)'

export function readPrefersReducedTransparency(): boolean {
  return readMediaQuery(REDUCED_TRANSPARENCY_QUERY)
}

/** One switch for main.css: the Reduce Visual Effects setting or the OS reduced-transparency preference. */
export function useReduceVisualEffects(enabled: boolean | undefined): boolean {
  const reduce = useMediaQuery(REDUCED_TRANSPARENCY_QUERY) || enabled === true

  useEffect(() => {
    const root = document.documentElement
    if (reduce) {
      root.dataset.reduceEffects = ''
    } else {
      delete root.dataset.reduceEffects
    }
  }, [reduce])

  return reduce
}
