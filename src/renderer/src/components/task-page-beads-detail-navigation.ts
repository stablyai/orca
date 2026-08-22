import { useCallback, useEffect, useState } from 'react'

import { translate } from '@/i18n/i18n'
import { beadsGetIssue, isBeadsTaskSourceUnsupportedError } from '@/runtime/runtime-beads-client'
import { useAppStore } from '@/store'
import type { BeadsIssue, BeadsIssueDetails } from '../../../shared/beads-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export function getBeadsDetailLoadFailedMessage(): string {
  return translate(
    'auto.components.TaskPage.beadsDetailLoadFailed',
    'Unable to load details for this Beads issue.'
  )
}

/** 'loading' = section skeletons, 'loaded' = render relations/comments, 'unavailable' = plain-issue rendering. */
export type BeadsDetailSectionsState = 'loading' | 'loaded' | 'unavailable'

export type BeadsIssueDetailNavigation = {
  issue: BeadsIssue
  /** Local patch hook for the meta band's optimistic status updates. */
  setIssue: (issue: BeadsIssue) => void
  details: BeadsIssueDetails | null
  sectionsState: BeadsDetailSectionsState
  loading: boolean
  detailsLoaded: boolean
  error: string | null
  /** Top of the in-dialog back stack; null when back should close to the list. */
  previousIssue: BeadsIssue | null
  navigateToIssue: (issue: BeadsIssue) => void
  /** Pops the back stack; false when it is empty so the caller closes the dialog. */
  navigateBack: () => boolean
  /** Swaps in re-fetched details (e.g. after posting a comment). */
  applyDetails: (details: BeadsIssueDetails) => void
}

/** In-dialog issue navigation plus the details load, degrading to `bd show`-less rendering on old hosts. */
export function useBeadsIssueDetailNavigation(
  sourceContext: TaskSourceContext,
  rootIssue: BeadsIssue
): BeadsIssueDetailNavigation {
  const fetchDetails = useAppStore((s) => s.fetchBeadsIssueDetails)
  // Why: the list row (or relation entry) is the synchronous shell; the fetch replaces it with the enriched issue.
  const [issue, setIssue] = useState<BeadsIssue>(rootIssue)
  const [stack, setStack] = useState<BeadsIssue[]>([])
  const [details, setDetails] = useState<BeadsIssueDetails | null>(null)
  const [sectionsState, setSectionsState] = useState<BeadsDetailSectionsState>('loading')
  const [loading, setLoading] = useState(true)
  const [detailsLoaded, setDetailsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const repoId = sourceContext.repoId ?? null
  const issueId = issue.id

  useEffect(() => {
    if (!repoId) {
      setLoading(false)
      setSectionsState('unavailable')
      setError(getBeadsDetailLoadFailedMessage())
      return
    }
    let cancelled = false
    // Old-host fallback: beads.getIssue predates beads.getIssueDetails, so the body still enriches.
    const loadPlainIssue = async (): Promise<void> => {
      try {
        const result = await beadsGetIssue(sourceContext, { repoId, id: issueId })
        if (cancelled) {
          return
        }
        if (result.issue) {
          setIssue(result.issue)
          setDetailsLoaded(true)
        } else {
          setError(getBeadsDetailLoadFailedMessage())
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(
            isBeadsTaskSourceUnsupportedError(err) ? err.message : getBeadsDetailLoadFailedMessage()
          )
        }
      }
    }
    fetchDetails(sourceContext, issueId)
      .then((loaded) => {
        if (cancelled) {
          return
        }
        if (loaded) {
          setIssue(loaded.issue)
          setDetails(loaded)
          setDetailsLoaded(true)
          setSectionsState('loaded')
        } else {
          // Why: null means bd is missing/outdated/uninitialized here, not an empty issue.
          setSectionsState('unavailable')
          setError(getBeadsDetailLoadFailedMessage())
        }
      })
      .catch(async (err: unknown) => {
        if (cancelled) {
          return
        }
        setSectionsState('unavailable')
        if (isBeadsTaskSourceUnsupportedError(err)) {
          await loadPlainIssue()
          return
        }
        setError(getBeadsDetailLoadFailedMessage())
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [fetchDetails, sourceContext, repoId, issueId])

  const resetToIssue = useCallback((next: BeadsIssue): void => {
    setIssue(next)
    setDetails(null)
    setDetailsLoaded(false)
    setSectionsState('loading')
    setLoading(true)
    setError(null)
  }, [])

  const navigateToIssue = useCallback(
    (next: BeadsIssue): void => {
      if (next.id === issue.id) {
        return
      }
      setStack((prev) => [...prev, issue])
      resetToIssue(next)
    },
    [issue, resetToIssue]
  )

  const previousIssue = stack.at(-1) ?? null

  const navigateBack = useCallback((): boolean => {
    if (!previousIssue) {
      return false
    }
    setStack((prev) => prev.slice(0, -1))
    resetToIssue(previousIssue)
    return true
  }, [previousIssue, resetToIssue])

  const applyDetails = useCallback((next: BeadsIssueDetails): void => {
    setDetails(next)
    setIssue(next.issue)
  }, [])

  return {
    issue,
    setIssue,
    details,
    sectionsState,
    loading,
    detailsLoaded,
    error,
    previousIssue,
    navigateToIssue,
    navigateBack,
    applyDetails
  }
}
