import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import { gitGraphScope } from '@/lib/git-graph-tab'
import { getConnectionId } from '@/lib/connection-context'
import { translate } from '@/i18n/i18n'
import type {
  GitHistoryRefs,
  GitHistoryResult
} from '../../../../../shared/git/history/git-history-types'

export const GIT_GRAPH_REFRESH_EVENT = 'orca:git-graph-refresh'

export function gitGraphFilterSupported(result?: GitHistoryResult): boolean | undefined {
  return result ? result.refs !== undefined : undefined
}

export function useGitGraphHistory(worktreeId: string) {
  const filterKey = useAppStore((state) =>
    JSON.stringify(state.gitGraphFiltersByWorktree?.[worktreeId] ?? 'all')
  )
  const filter = useMemo<GitHistoryRefs>(() => JSON.parse(filterKey), [filterKey])
  const owner = useAppStore(() => JSON.stringify(gitGraphScope(worktreeId)?.route))
  const scope = useMemo(() => (owner ? gitGraphScope(worktreeId) : null), [worktreeId, owner])
  const [result, setResult] = useState<GitHistoryResult>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const state = useRef<{
    generation: number
    result?: GitHistoryResult
    pending: boolean
    recovered: boolean
  }>({ generation: 0, pending: false, recovered: false })
  const load = useCallback(
    async (append = false): Promise<GitHistoryResult | undefined> => {
      const current = state.current
      if (append && (current.pending || !current.result?.hasMore)) {
        return current.result
      }
      if (!append) {
        current.generation++
        current.recovered = false
      }
      let generation = current.generation
      const context = gitGraphScope(worktreeId)
      if (JSON.stringify(context?.route) !== owner) {
        return undefined
      }
      if (!context) {
        return undefined
      }
      const previous = append ? current.result : undefined
      current.pending = true
      setLoading(true)
      setError(undefined)
      try {
        const get = (token?: string, skip = 0) =>
          getRuntimeGitHistory(
            {
              target: context.target,
              worktreeId,
              worktreePath: context.worktree.path,
              connectionId: getConnectionId(worktreeId) ?? undefined
            },
            { refs: filter, limit: 50, historyToken: token, skip, wakeWslDistro: !append }
          )
        let page = await get(previous?.historyToken, previous?.items.length ?? 0)
        if (generation !== current.generation) {
          return undefined
        }
        let base = previous
        if (page.historyChanged) {
          if (current.recovered) {
            throw new Error(
              translate(
                'gitGraph.historyChanged',
                'History changed again. Refresh the Git Graph to try again.'
              )
            )
          }
          current.generation++
          generation = current.generation
          current.recovered = true
          page = await get()
          base = undefined
          if (page.historyChanged) {
            throw new Error(
              translate(
                'gitGraph.historyChanged',
                'History changed again. Refresh the Git Graph to try again.'
              )
            )
          }
        }
        if (generation !== current.generation) {
          return undefined
        }
        const existingIds = new Set(base?.items.map((item) => item.id))
        const next = base
          ? {
              ...page,
              items: [...base.items, ...page.items.filter((item) => !existingIds.has(item.id))]
            }
          : page
        current.result = next
        setResult(next)
        if (
          Array.isArray(filter) &&
          page.resolvedRefs &&
          JSON.stringify(filter) !== JSON.stringify(page.resolvedRefs)
        ) {
          useAppStore.setState((store) => ({
            gitGraphFiltersByWorktree: {
              ...store.gitGraphFiltersByWorktree,
              [worktreeId]: page.resolvedRefs!.length ? page.resolvedRefs! : 'head'
            }
          }))
        }
        return next
      } catch (cause) {
        if (generation === current.generation) {
          setError(
            cause instanceof Error
              ? cause.message
              : translate('gitGraph.loadFailed', 'Failed to load Git history')
          )
        }
        return undefined
      } finally {
        if (generation === current.generation) {
          current.pending = false
          setLoading(false)
        }
      }
    },
    [worktreeId, filter, owner]
  )
  useEffect(() => {
    const current = state.current
    current.result = undefined
    setResult(undefined)
    void load()
    const refresh = () => {
      void load()
    }
    window.addEventListener(GIT_GRAPH_REFRESH_EVENT, refresh)
    return () => {
      current.generation++
      window.removeEventListener(GIT_GRAPH_REFRESH_EVENT, refresh)
    }
  }, [load])
  const changeFilter = (refs: GitHistoryRefs) =>
    useAppStore.setState((store) => ({
      gitGraphFiltersByWorktree: { ...store.gitGraphFiltersByWorktree, [worktreeId]: refs }
    }))
  const reveal = async (id: string) => {
    const generation = state.current.generation
    let page = state.current.result
    while (
      page &&
      !page.items.some((item) => item.id === id) &&
      page.hasMore &&
      generation === state.current.generation &&
      !state.current.pending
    ) {
      const previous = page
      page = await load(true)
      if (page === previous) {
        break
      }
    }
    return page?.items.findIndex((item) => item.id === id) ?? -1
  }
  return {
    filter,
    changeFilter,
    result,
    error,
    loading,
    refresh: () => load(),
    loadMore: () => load(true),
    reveal,
    scope
  }
}
