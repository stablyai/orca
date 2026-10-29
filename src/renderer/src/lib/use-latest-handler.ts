import { useCallback, useLayoutEffect, useRef } from 'react'

/** A stable function that calls the latest committed `handler`, so memoized children skip re-rendering when only a closure changed. */
export function useLatestHandler<A extends unknown[], R>(
  handler: (...args: A) => R
): (...args: A) => R {
  const latest = useRef(handler)
  useLayoutEffect(() => {
    latest.current = handler
  })
  return useCallback((...args: A) => latest.current(...args), [])
}
