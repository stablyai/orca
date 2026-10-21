import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
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
  // Why: refs live on the repo's own host, not the focused one.
  const repoHostId = useAppStore((s) => {
    const repo = findRepoForHost(s.repos, repoId, { settings: s.settings })
    return repo ? getRepoExecutionHostId(repo) : null
  })

  // Why: resolved separately from eligibility's defaultBaseRef, which reports the
  // worktree's own base. Consumers that need "is this the repo's default branch?"
  // must ask this one, not that one.
  useEffect(() => {
    // Why: the repo default doesn't move while a repo stays open, so skip the probe
    // once it is known — on a remote runtime it is an RPC round-trip per composer open.
    if (!open || repoDefaultBaseRef || !repoHostId) {
      return
    }
    let stale = false
    void getRuntimeRepoBaseRefDefault(repoHostId, repoId)
      .then((result) => {
        if (!stale && result.defaultBaseRef) {
          setRepoDefault({ repoId, baseRef: stripBaseRef(result.defaultBaseRef) })
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [open, repoDefaultBaseRef, repoHostId, repoId])

  useEffect(() => {
    if (!open || base || !repoDefaultBaseRef) {
      return
    }
    setBase(repoDefaultBaseRef)
  }, [base, open, repoDefaultBaseRef, setBase])

  useEffect(() => {
    if (!open || !repoHostId || baseQuery.trim().length < 2) {
      setBaseResults([])
      setBaseSearchPending(false)
      setBaseSearchError(null)
      return
    }
    let stale = false
    setBaseSearchPending(true)
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefDetails(repoHostId, repoId, baseQuery.trim(), 20)
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
  }, [
    baseQuery,
    open,
    repoHostId,
    repoId,
    setBaseResults,
    setBaseSearchError,
    setBaseSearchPending
  ])

  return repoDefaultBaseRef
}
