import { useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react'
import type { SourceControlActionError } from '../sync/action-error'

/** A landed switch supersedes the workspace's last action error, including a remote action still in flight. */
export function useBranchSwitchOutcome(
  setErrors: Dispatch<SetStateAction<Record<string, SourceControlActionError | null>>>,
  sequences: RefObject<Record<string, number>>
) {
  return useCallback(
    (id: string, refresh?: () => Promise<void>) => {
      sequences.current[id] = (sequences.current[id] ?? 0) + 1
      setErrors((previous) => (previous[id] ? { ...previous, [id]: null } : previous))
      if (refresh) {
        void refresh().catch(() => {})
      }
    },
    [setErrors, sequences]
  )
}
