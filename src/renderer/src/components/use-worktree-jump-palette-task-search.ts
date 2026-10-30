import { beginGitHubTaskRead, type GitHubTaskRead } from '@/store/github/request-coordination'
import { makeCmdJTaskSearchResult } from './cmd-j/task-search-results'
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useState } from 'react'
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
  groups: ReadonlyMap<string, { results: CmdJTaskSearchResult[]; commit?: () => void }>
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
  useLayoutEffect(() => {
    for (const group of snapshot?.groups.values() ?? []) {
      group.commit?.()
    }
  }, [snapshot])
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
  const buildRequests = useEffectEvent((signal: AbortSignal) => ({
    repos,
    requests: createCmdJTaskSearchRequests({
      query: query.trim(),
      repos,
      settings,
      accountBackedTaskSourceHostId: defaultHostId,
      filter: effectiveFilter,
      hostLabels,
      signal
    })
  }))
  useEffect(() => {
    if (!searchEnabled) {
      return
    }
    const controller = new AbortController()
    const reads = new Set<GitHubTaskRead>()
    const failures: string[] = []
    const { requests, repos: requestRepos } = buildRequests(controller.signal)
    let loadingVisible = false
    let pending = requests.length
    const publish = (): void => {
      if (!controller.signal.aborted) {
        const loading = pending > 0 && loadingVisible
        const failed = [...failures]
        setSnapshot((current) => ({
          key: requestKey,
          session,
          groups:
            current?.key === requestKey && current.session === session ? current.groups : new Map(),
          loading,
          failures: failed
        }))
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
        let read: GitHubTaskRead | undefined
        try {
          read = request.githubSource
            ? beginGitHubTaskRead([request.githubSource], undefined, { repos: requestRepos })
            : undefined
          if (read) {
            reads.add(read)
          }
          const results = await request.run(read || undefined)
          if (controller.signal.aborted) {
            return
          }
          const loading = pending > 1 && loadingVisible
          const failed = [...failures]
          if (read) {
            const template = new Map(
              results.map((result) => [
                result.task.issue.url,
                {
                  sourceContext: result.sourceContext,
                  initialRepoId: result.initialRepoId,
                  hostLabel: result.hostLabel
                }
              ])
            )
            const items = results.flatMap((result) =>
              result.task.provider === 'github' ? [result.task.issue] : []
            )
            read.deliver(items, (update) =>
              setSnapshot((current) => {
                const groups = new Map(
                  current?.key === requestKey && current.session === session ? current.groups : []
                )
                const existing = groups.get(request.id)?.results ?? []
                const rows = update(
                  existing.flatMap((result) =>
                    result.task.provider === 'github' ? [result.task.issue] : []
                  )
                )
                const receipt = 'commit' in update ? update.commit : undefined
                groups.set(request.id, {
                  results: rows.flatMap((issue) => {
                    const wrapper = template.get(issue.url)
                    return wrapper
                      ? [
                          makeCmdJTaskSearchResult(
                            { provider: 'github', issue },
                            wrapper.sourceContext,
                            wrapper.initialRepoId,
                            wrapper.hostLabel
                          )
                        ]
                      : []
                  }),
                  commit: typeof receipt === 'function' ? () => receipt() : undefined
                })
                return {
                  key: requestKey,
                  session,
                  groups,
                  loading:
                    current?.key === requestKey && current.session === session
                      ? current.loading
                      : loading,
                  failures:
                    current?.key === requestKey && current.session === session
                      ? current.failures
                      : failed
                }
              })
            )
          } else {
            setSnapshot((current) => {
              const groups = new Map(
                current?.key === requestKey && current.session === session ? current.groups : []
              )
              groups.set(request.id, { results })
              return { key: requestKey, session, groups, loading, failures: failed }
            })
          }
        } catch {
          if (!controller.signal.aborted) {
            failures.push(`${request.provider} · ${request.hostLabel}`)
          }
        } finally {
          const completed = read
          completed?.finish(() => reads.delete(completed))
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
      for (const read of reads) {
        read.dispose()
      }
      clearTimeout(debounce)
      clearTimeout(loadingTimer)
    }
  }, [searchEnabled, session, requestKey])
  const current =
    searchEnabled && snapshot?.key === requestKey && snapshot.session === session ? snapshot : null
  const groups = current?.groups
  const taskItems = useMemo(
    () =>
      (groups
        ? mergeCmdJTaskSearchResults([...groups.values()].map((group) => group.results))
        : EMPTY_RESULTS
      ).map((result) => ({
        id: result.id,
        type: 'task' as const,
        result
      })),
    [groups]
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
