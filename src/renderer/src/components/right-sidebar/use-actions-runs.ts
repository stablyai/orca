import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { fetchActionsRuns, fetchActionsWorkflows } from '@/store/github/actions-requests'
import type {
  ActionsPage,
  ActionsRun,
  ActionsRunsQuery,
  ActionsWorkflow
} from '../../../../shared/github/actions-types'
import type { ActionsRepositoryOption } from './use-actions-repositories'
import { actionsRepoProbeKey } from './actions-repositories'

const DEFAULT_QUERY: ActionsRunsQuery = { page: 1 }

/** Keep run filters and workflow pagination independent; ignore stale reads and retry failed workflow pages in place. */
export function useActionsRuns(option: ActionsRepositoryOption | undefined) {
  const [queryState, setQuery] = useState<{ identity: string; query: ActionsRunsQuery }>({
    identity: '',
    query: { page: 1 }
  })
  const [nonce, setNonce] = useState(0)
  const identity = option ? actionsRepoProbeKey(option.repo) : ''
  const query = queryState.identity === identity ? queryState.query : DEFAULT_QUERY
  const key = JSON.stringify([identity, query, nonce])
  const [result, setResult] = useState<{
    key: string
    identity: string
    data: ActionsPage<ActionsRun> | null
    loading: boolean
    error: string | null
  }>({ identity: '', key: '', data: null, loading: false, error: null })
  const [workflowRetry, setWorkflowRetry] = useState(0)
  const [workflowState, setWorkflowPage] = useState({ identity: '', page: 1 })
  const workflowPage = workflowState.identity === identity ? workflowState.page : 1
  const [workflows, setWorkflows] = useState<{
    identity: string
    page: number
    items: ActionsWorkflow[]
    more: boolean
    limit: boolean
    error: string | null
    loading: boolean
  }>({ identity: '', page: 0, items: [], more: false, limit: false, error: null, loading: false })
  useEffect(() => {
    let live = true
    if (!option) {
      setResult({ identity, key, data: null, loading: false, error: null })
      return
    }
    setResult((prior) => ({
      key,
      identity,
      data: prior.identity === identity ? prior.data : null,
      loading: true,
      error: null
    }))
    void fetchActionsRuns(
      useAppStore.getState(),
      { repoId: option.repo.id, repoPath: option.repo.path },
      { ...query, noCache: nonce > 0 }
    ).then(
      (data) => {
        if (live) {
          setResult({ identity, key, data, loading: false, error: null })
        }
      },
      (error) => {
        if (live) {
          setResult((prior) => ({
            ...prior,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    )
    return () => {
      live = false
    }
  }, [key, identity, option, query, nonce])
  useEffect(() => {
    let live = true
    if (!option) {
      return
    }
    setWorkflows((prior) => ({
      ...prior,
      identity,
      page: prior.identity === identity ? prior.page : 0,
      more: prior.identity === identity ? prior.more : false,
      limit: prior.identity === identity ? prior.limit : false,
      items: prior.identity === identity && workflowPage > 1 ? prior.items : [],
      loading: true,
      error: null
    }))
    void fetchActionsWorkflows(
      useAppStore.getState(),
      { repoId: option.repo.id, repoPath: option.repo.path },
      { page: workflowPage, noCache: nonce > 0 }
    ).then(
      (page) => {
        if (live) {
          setWorkflows((prior) => ({
            identity,
            page: workflowPage,
            items: workflowPage === 1 ? page.items : [...prior.items, ...page.items],
            more: page.hasNextPage,
            limit: page.limitReached,
            error: null,
            loading: false
          }))
        }
      },
      (error) => {
        if (live) {
          setWorkflows((prior) => ({
            ...prior,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    )
    return () => {
      live = false
    }
  }, [identity, option, workflowPage, workflowRetry, nonce])
  return {
    query,
    /** Bind the next run filter to this repository identity, defaulting omitted paging to the first page. */
    setQuery: (next: ActionsRunsQuery) =>
      setQuery({ identity, query: { ...next, page: next.page ?? 1 } }),
    data: result.key === key ? result.data : null,
    loading: result.key !== key || result.loading,
    error: result.key === key ? result.error : null,
    workflows:
      workflows.identity === identity
        ? workflows
        : { items: [], more: false, limit: false, loading: false, error: null },
    /** Retry or advance the workflow page without clearing loaded workflows or changing run paging. */
    moreWorkflows: () => {
      setWorkflowPage({ identity, page: workflows.page + 1 })
      setWorkflowRetry((value) => value + 1)
    },
    /** Restart both lists at page one and invalidate cached reads only for an explicit full refresh. */
    refresh: () => {
      setQuery({ identity, query: { ...query, page: 1 } })
      setWorkflowPage({ identity, page: 1 })
      setNonce((value) => value + 1)
    }
  }
}
