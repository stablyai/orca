import { useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react'
import type { SourceControlActionError } from '../sync/action-error'

export function useBranchSwitchOutcome(
  setErrors: Dispatch<SetStateAction<Record<string, SourceControlActionError | null>>>,
  sequences: RefObject<Record<string, number>>
) {
  return useCallback(
    (id: string, message?: string, refresh?: () => Promise<void>) => {
      const sequence = (sequences.current[id] ?? 0) + 1
      sequences.current[id] = sequence
      setErrors((previous) => ({
        ...previous,
        [id]: message ? { kind: 'switch_branch', message, rawError: message, sequence } : null
      }))
      if (refresh) {
        void refresh().catch(() => {})
      }
    },
    [setErrors, sequences]
  )
}
