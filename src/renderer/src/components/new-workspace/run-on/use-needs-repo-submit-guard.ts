// RR-c1 (Neil): submit-time validation for Orca Cloud on a plain-folder project. Nothing shows while
// options are picked; Create (button or ⌘↵) stops before submitting and the error appears under
// Project. It clears once a GitHub repository is picked or Run on leaves Orca Cloud.
import { useCallback, useMemo, useState } from 'react'

export function useNeedsRepoSubmitGuard<T extends object>(
  /** Non-null while Orca Cloud is on a folder with no GitHub repository picked. */
  needsRepo: T | null,
  submit: () => void
): {
  onPrimary: () => void
  /** The error to show (with how many Creates it stopped), or null: never before a Create. */
  shown: (T & { attempt: number }) | null
} {
  const active = needsRepo !== null
  const [stopped, setStopped] = useState({ attempt: 0, active })
  // Resolved (or back again): start over in the same render, so a stale error never shows.
  if (stopped.active !== active) {
    setStopped({ attempt: 0, active })
  }
  const attempt = stopped.active === active ? stopped.attempt : 0
  const onPrimary = useCallback(() => {
    if (needsRepo) {
      // Never submitted: a create can't fail on the server for this.
      setStopped((current) => ({ attempt: current.attempt + 1, active: true }))
      return
    }
    submit()
  }, [needsRepo, submit])
  const shown = useMemo(
    () => (needsRepo && attempt > 0 ? { ...needsRepo, attempt } : null),
    [needsRepo, attempt]
  )
  return { onPrimary, shown }
}
