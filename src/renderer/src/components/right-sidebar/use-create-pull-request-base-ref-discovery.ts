import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppState } from '@/store'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefDetails
} from '@/runtime/runtime-repo-client'
import {
  normalizeCreateReviewBaseSearchResults,
  stripBaseRef
} from './create-pull-request-base-ref-normalization'

type CreatePullRequestBaseRefDiscoveryOptions = {
  open: boolean
  repoId: string
  settings: AppState['settings']
  base: string
  baseQuery: string
  setBase: Dispatch<SetStateAction<string>>
  setBaseResults: Dispatch<SetStateAction<string[]>>
  setBaseSearchPending: Dispatch<SetStateAction<boolean>>
  setBaseSearchError: Dispatch<SetStateAction<string | null>>
}

export function useCreatePullRequestBaseRefDiscovery({
  open,
  repoId,
  settings,
  base,
  baseQuery,
  setBase,
  setBaseResults,
  setBaseSearchPending,
  setBaseSearchError
}: CreatePullRequestBaseRefDiscoveryOptions): string | null {
  // Why: stamped with the repo it came from — this hook outlives a repo switch, and a
  // previous repo's default branch would silently suppress the stacked-PR lookup.
  const [repoDefault, setRepoDefault] = useState<{ repoId: string; baseRef: string } | null>(null)
  const repoDefaultBaseRef = repoDefault?.repoId === repoId ? repoDefault.baseRef : null

  // Why: resolved separately from eligibility's defaultBaseRef, which reports the
  // worktree's own base. Consumers that need "is this the repo's default branch?"
  // must ask this one, not that one.
  useEffect(() => {
    // Why: the repo default doesn't move while a repo stays open, so skip the probe
    // once it is known — on a remote runtime it is an RPC round-trip per composer open.
    if (!open || repoDefaultBaseRef) {
      return
    }
    let stale = false
    void getRuntimeRepoBaseRefDefault(settings, repoId)
      .then((result) => {
        if (!stale && result.defaultBaseRef) {
          setRepoDefault({ repoId, baseRef: stripBaseRef(result.defaultBaseRef) })
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [open, repoDefaultBaseRef, repoId, settings])

  useEffect(() => {
    if (!open || base || !repoDefaultBaseRef) {
      return
    }
    setBase(repoDefaultBaseRef)
  }, [base, open, repoDefaultBaseRef, setBase])

  useEffect(() => {
    if (!open || baseQuery.trim().length < 2) {
      setBaseResults([])
      setBaseSearchPending(false)
      setBaseSearchError(null)
      return
    }
    let stale = false
    setBaseSearchPending(true)
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefDetails(settings, repoId, baseQuery.trim(), 20)
        .then((results) => {
          if (!stale) {
            setBaseResults(normalizeCreateReviewBaseSearchResults(results))
            setBaseSearchError(null)
          }
        })
        .catch(() => {
          if (!stale) {
            setBaseResults([])
            setBaseSearchError('Branch discovery failed.')
          }
        })
        .finally(() => {
          if (!stale) {
            setBaseSearchPending(false)
          }
        })
    }, 200)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [baseQuery, open, repoId, settings, setBaseResults, setBaseSearchError, setBaseSearchPending])

  return repoDefaultBaseRef
}
