import { useCallback, useRef } from 'react'

export type CombinedDiffDirectScrollInput = {
  hasDirectScrollInput: () => boolean
  markDirectScrollInput: () => void
}

export function useCombinedDiffDirectScrollInput(): CombinedDiffDirectScrollInput {
  const directScrollInputUntilRef = useRef(0)

  const markDirectScrollInput = useCallback((): void => {
    directScrollInputUntilRef.current = window.performance.now() + 250
  }, [])

  const hasDirectScrollInput = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )

  return { hasDirectScrollInput, markDirectScrollInput }
}
