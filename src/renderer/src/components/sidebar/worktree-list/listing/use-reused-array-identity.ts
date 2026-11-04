import { useEffect, useRef } from 'react'
import { reuseArrayIfEqual } from '../../worktree-agent-row-selectors'

// Reuse equal arrays for downstream memos; elements must be replaced immutably, never mutated in place.
export function useReusedArrayIdentity<T>(next: T[]): T[] {
  const previousRef = useRef<T[]>(next)
  const result = reuseArrayIfEqual(previousRef.current, next)
  // Why effect: React can replay or discard render, so a render-time ref write can leak a discarded identity.
  useEffect(() => {
    previousRef.current = result
  }, [result])
  return result
}
