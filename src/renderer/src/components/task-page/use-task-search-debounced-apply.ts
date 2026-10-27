import { useEffect } from 'react'
import { TASK_SEARCH_DEBOUNCE_MS } from './task-page-source-context'

/** Applies a task search input after the shared debounce, once resume state has landed. */
export function useTaskSearchDebouncedApply(
  input: string,
  ready: boolean,
  apply: (value: string) => void
): void {
  useEffect(() => {
    if (!ready) {
      return
    }
    const timeout = window.setTimeout(() => apply(input), TASK_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [input, ready, apply])
}
