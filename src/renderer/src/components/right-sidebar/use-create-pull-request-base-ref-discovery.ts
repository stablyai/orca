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
  // Stamp the repo so an old default cannot suppress stacked-PR lookup after navigation.
  const [repoDefault, setRepoDefault] = useState<{ repoId: string; baseRef: string } | null>(null)
  const repoDefaultBaseRef = repoDefault?.repoId === repoId ? repoDefault.baseRef : null
  // Refs belong to the repo owner, which may differ from the focused host.
  const repoHostId = useAppStore((s) => {
    const repo = findRepoForHost(s.repos, repoId, { settings: s.settings })
    return repo ? getRepoExecutionHostId(repo) : null
  })

  // Resolve the repo default separately; eligibility’s defaultBaseRef can be the worktree’s own base.
  useEffect(() => {
    // Cache the stable repo default to avoid an RPC on every composer opening.
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
