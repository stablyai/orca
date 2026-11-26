import { useCallback, useEffect, useRef, useState } from 'react'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { mapSettledWithConcurrency } from '../../../../../shared/concurrency/map-with-concurrency'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'

const NGIT_TASK_FETCH_CONCURRENCY = 4

export type NgitWorkItemsState = {
  items: NgitWorkItem[]
  /** Selected repositories that turned out to be ngit repositories. */
  ngitRepos: Repo[]
  errors: string[]
  loading: boolean
  refresh: () => void
}

export function useNgitWorkItems(repos: readonly Repo[], reposKey: string): NgitWorkItemsState {
  const [result, setResult] = useState<{
    key: string
    items: NgitWorkItem[]
    ngitRepos: Repo[]
    errors: string[]
  }>({ key: '', items: [], ngitRepos: [], errors: [] })
  const [loading, setLoading] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const lastNonceRef = useRef(0)
  const reposRef = useRef(repos)
  reposRef.current = repos

  useEffect(() => {
    const force = refreshNonce !== lastNonceRef.current
    lastNonceRef.current = refreshNonce
    let stale = false
    setLoading(true)
    const selected = reposRef.current
    void mapSettledWithConcurrency(selected, NGIT_TASK_FETCH_CONCURRENCY, (repo) =>
      ngitApiFor(repo).listWorkItems(force)
    ).then((settled) => {
      if (stale) {
        return
      }
      const items: NgitWorkItem[] = []
      const ngitRepos: Repo[] = []
      const errors: string[] = []
      settled.forEach((outcome, index) => {
        const repo = selected[index]
        if (outcome.status === 'rejected') {
          errors.push(
            `${repo.displayName}: ${readIpcErrorDetail(outcome.reason) ?? String(outcome.reason)}`
          )
        } else if (outcome.value.repository) {
          ngitRepos.push(repo)
          const repoHostId = getRepoExecutionHostId(repo)
          items.push(...outcome.value.items.map((item) => ({ ...item, repoHostId })))
        }
      })
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      setResult({ key: reposKey, items, ngitRepos, errors })
      setLoading(false)
    })
    return () => {
      stale = true
    }
  }, [reposKey, refreshNonce])

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), [])
  // Rows belong to the selection that loaded them.
  const current = result.key === reposKey
  return {
    items: current ? result.items : [],
    ngitRepos: current ? result.ngitRepos : [],
    errors: current ? result.errors : [],
    loading: loading || !current,
    refresh
  }
}
