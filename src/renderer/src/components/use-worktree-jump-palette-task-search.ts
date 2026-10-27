import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import { createCmdJTaskSearchRequests } from './cmd-j/task-search-requests'
import {
  isCmdJTaskSearchQuery,
  mergeCmdJTaskSearchResults,
  type CmdJTaskSearchResult
} from './cmd-j/task-search-results'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
const TASK_SEARCH_DEBOUNCE_MS = 600

type Input = Pick<WorktreeJumpPaletteStoreState, 'visible' | 'repos' | 'settings'> &
  Pick<WorktreeJumpPaletteLocalState, 'query' | 'filter'> &
  Pick<WorktreeJumpPaletteFilter, 'hostOptions' | 'filterModel' | 'defaultHostId'>
type SearchSnapshot = {
  key: string
  session: object
  results: CmdJTaskSearchResult[]
  loading: boolean
  failures: string[]
}
const EMPTY_RESULTS: CmdJTaskSearchResult[] = []
const EMPTY_FAILURES: string[] = []

export function useWorktreeJumpPaletteTaskSearch({
  visible,
  query,
  repos,
  settings,
  filter,
  hostOptions,
  filterModel,
  defaultHostId
}: Input) {
  const connectionScope = useAppStore(
    useShallow((state) => ({
      jira: state.jiraConnectionRevisions,
      linear: state.linearStatus,
      linearContext: state.linearStatusContextKey
    }))
  )
  const [snapshot, setSnapshot] = useState<SearchSnapshot | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const hostLabels = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
  const session = useMemo(() => ({ visible }), [visible])
  const effectiveFilter = {
    ...filter,
    hostIds: [
      ...new Set(
        filter.hostIds.flatMap((id) => [id, ...(filterModel.equivalentHostIdsById?.get(id) ?? [])])
      )
    ]
  }
  const searchEnabled = visible && isCmdJTaskSearchQuery(query)
  const requestKey = JSON.stringify([
    query.trim(),
    effectiveFilter,
    defaultHostId,
    settings?.visibleTaskProviders,
    repos.map((repo) => [
      repo.id,
      repo.path,
      getRepoExecutionHostId(repo),
      repo.gitRemoteIdentity,
      repo.ghAccount,
      repo.issueSourcePreference,
      repo.kind
    ]),
    connectionScope,
    retryNonce
  ])
  const buildRequests = useEffectEvent((signal: AbortSignal) =>
    createCmdJTaskSearchRequests({
      query: query.trim(),
      repos,
      settings,
      accountBackedTaskSourceHostId: defaultHostId,
      filter: effectiveFilter,
      hostLabels,
      signal
    })
  )
  useEffect(() => {
    if (!searchEnabled) {
      return
    }
    const controller = new AbortController()
    const resultsByRequest = new Map<string, CmdJTaskSearchResult[]>()
    const failures: string[] = []
    const requests = buildRequests(controller.signal)
    let loadingVisible = false
    let pending = requests.length
    const publish = (): void => {
      if (!controller.signal.aborted) {
        setSnapshot({
          key: requestKey,
          session,
          results: mergeCmdJTaskSearchResults([...resultsByRequest.values()]),
          loading: pending > 0 && loadingVisible,
          failures: [...failures]
        })
      }
    }
    const loadingTimer = setTimeout(() => {
      loadingVisible = true
      publish()
    }, TASK_SEARCH_DEBOUNCE_MS + 200)
    const debounce = setTimeout(() => {
      // Account sources go first so many repositories cannot hold their results behind a long queue.
      requests.sort(
        (a, b) =>
          Number(a.provider === 'github' || a.provider === 'gitlab') -
          Number(b.provider === 'github' || b.provider === 'gitlab')
      )
      void forEachWithConcurrency(requests, 4, async (request) => {
        if (controller.signal.aborted) {
          return
        }
        try {
          const results = await request.run()
          resultsByRequest.set(request.id, results)
        } catch {
          if (!controller.signal.aborted) {
            failures.push(`${request.provider} · ${request.hostLabel}`)
          }
        } finally {
          pending -= 1
          publish()
        }
      }).then(() => {
        clearTimeout(loadingTimer)
        publish()
      })
      if (requests.length === 0) {
        publish()
      }
    }, TASK_SEARCH_DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(debounce)
      clearTimeout(loadingTimer)
    }
  }, [searchEnabled, session, requestKey])
  const current =
    searchEnabled && snapshot?.key === requestKey && snapshot.session === session ? snapshot : null
  const taskItems = useMemo(
    () =>
      (current?.results ?? EMPTY_RESULTS).map((result) => ({
        id: result.id,
        type: 'task' as const,
        result
      })),
    [current?.results]
  )
  const retryTaskSearch = (): void => setRetryNonce((value) => value + 1)
  return {
    taskItems,
    taskSearchLoading: current?.loading ?? false,
    taskSearchFailures: current?.failures ?? EMPTY_FAILURES,
    retryTaskSearch
  }
}
export type WorktreeJumpPaletteTaskSearch = ReturnType<typeof useWorktreeJumpPaletteTaskSearch>
