// RR-c1 (Neil): submit-time validation for Orca Cloud on a plain-folder project. Nothing shows while
// options are picked; Create (button or ⌘↵) stops before submitting and the error appears under
// Project. It clears once a GitHub repository is picked or Run on leaves Orca Cloud.
import { useCallback, useEffect, useMemo, useState } from 'react'

export function useNeedsRepoSubmitGuard<T extends object>(
  /** Non-null while Orca Cloud is on a folder with no GitHub repository picked. */
  needsRepo: T | null,
  submit: () => void
): {
  onPrimary: () => void
  /** The error to show (with how many Creates it stopped), or null: never before a Create. */
  shown: (T & { attempt: number }) | null
} {
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!needsRepo) {
      setAttempt(0)
    }
  }, [needsRepo])
  const onPrimary = useCallback(() => {
    if (needsRepo) {
      // Never submitted: a create can't fail on the server for this.
      setAttempt((current) => current + 1)
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
