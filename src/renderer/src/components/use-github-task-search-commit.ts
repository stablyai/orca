import { useEffect, useLayoutEffect, useRef } from 'react'

// Remote GitHub fan-out needs a longer idle window; Enter still commits immediately.
export const GITHUB_TASK_SEARCH_IDLE_MS = 750

type GitHubTaskSearchCommitOptions = {
  enabled: boolean
  onCommit: (value: string) => void
  value: string
}

export function useGitHubTaskSearchCommit({
  enabled,
  onCommit,
  value
}: GitHubTaskSearchCommitOptions): void {
  const onCommitRef = useRef(onCommit)
  const latestValueRef = useRef(value)
  const latestEnabledRef = useRef(enabled)
  // Keep latest callback without restarting the idle timer when identity changes.
  useLayoutEffect(() => {
    onCommitRef.current = onCommit
    latestValueRef.current = value
    latestEnabledRef.current = enabled
  }, [enabled, onCommit, value])

  useEffect(() => {
    if (!enabled) {
      return
    }
    const scheduledValue = value
    const timeout = window.setTimeout(() => {
      // A delayed cleanup must not commit a prefix that is no longer current.
      if (!latestEnabledRef.current || latestValueRef.current !== scheduledValue) {
        return
      }
      onCommitRef.current(scheduledValue)
    }, GITHUB_TASK_SEARCH_IDLE_MS)
    return () => window.clearTimeout(timeout)
  }, [enabled, value])
}
