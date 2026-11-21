import { useEffect, useRef } from 'react'
import { reuseArrayIfEqual } from '../../workspace-card/activity/worktree-agent-row-selectors'

// Reuse equal arrays for downstream memos; elements must be replaced immutably, never mutated in place.
export function useReusedArrayIdentity<T>(next: T[]): T[] {
  const previousRef = useRef<{ next: T[]; result: T[] }>({ next, result: next })
  // The same input as last time gives the same answer without comparing it again.
  const previous = previousRef.current
  const result = previous.next === next ? previous.result : reuseArrayIfEqual(previous.result, next)
  // Why effect: React can replay or discard render, so a render-time ref write can leak a discarded identity.
  useEffect(() => {
    previousRef.current = { next, result }
  }, [next, result])
  return result
}
