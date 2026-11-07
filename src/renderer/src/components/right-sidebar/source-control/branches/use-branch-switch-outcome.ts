import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { SourceControlActionError } from '../sync/action-error'

/** A landed switch clears the workspace's last action error, which belonged to the previous branch. */
export function useBranchSwitchOutcome(
  setErrors: Dispatch<SetStateAction<Record<string, SourceControlActionError | null>>>
) {
  return useCallback(
    (id: string, refresh?: () => Promise<void>) => {
      setErrors((previous) => (previous[id] ? { ...previous, [id]: null } : previous))
      if (refresh) {
        void refresh().catch(() => {})
      }
    },
    [setErrors]
  )
}
