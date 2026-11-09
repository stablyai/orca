import { useCallback, useEffect, useRef } from 'react'

/**
 * Per-channel "latest request wins": `begin('keys')` returns a check that is true only while no
 * newer request on that channel has started and the component is still mounted, so a slow,
 * stale response can never overwrite fresher data (or set state after unmount).
 */
export function useRequestGeneration(): (channel: string) => () => boolean {
  const generations = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback((channel: string) => {
    const mine = (generations.current.get(channel) ?? 0) + 1
    generations.current.set(channel, mine)
    return () => mounted.current && generations.current.get(channel) === mine
  }, [])
}
