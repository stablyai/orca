import { useEffect, useRef } from 'react'
import { reuseArrayIfEqual } from '../../worktree-agent-row-selectors'

// Why: epoch-driven recomputes often produce arrays whose contents and order are unchanged; reusing the previous identity when element-wise equal keeps downstream memos and React.memo'd cards bailing out. Safe only because elements (Worktree objects / id strings) are immutably REPLACED on change — never wrap arrays of mutated-in-place objects.
export function useReusedArrayIdentity<T>(next: T[]): T[] {
  const previousRef = useRef<T[]>(next)
  const result = reuseArrayIfEqual(previousRef.current, next)
  // Why effect: React can replay or discard render, so a render-time ref write can leak a discarded identity.
  useEffect(() => {
    previousRef.current = result
  }, [result])
  return result
}
