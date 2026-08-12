import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-client'
import { getConnectionId } from '@/lib/connection-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { translate } from '@/i18n/i18n'
import {
  GIT_GRAPH_DEFAULT_LIMIT,
  GIT_GRAPH_MAX_LIMIT,
  GIT_HISTORY_MAX_LIMIT,
  type GitHistoryResult
} from '../../../../shared/git-history'

export type GitGraphHistoryState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

export function useGitGraphHistory(worktreeId: string): {
  state: GitGraphHistoryState
  // True when the remote host predates allRefs and served HEAD-only history.
  remoteUnsupported: boolean
  worktreePath: string | null
  activeRepoSettings: ReturnType<typeof getRepoOwnerRoutedSettings>
  refresh: () => void
  loadMore: () => void
  canLoadMore: boolean
} {
  const worktree = useAppStore((s) => s.getKnownWorktreeById(worktreeId) ?? null)
  const repo = useAppStore((s) => {
    const repoId = worktree?.repoId
    return repoId ? (s.repos.find((candidate) => candidate.id === repoId) ?? null) : null
  })
  const settings = useAppStore((s) => s.settings)
  const activeRepoSettings = useMemo(
    () =>
      getRepoOwnerRoutedSettings(
        settings,
        repo
          ? { id: repo.id, connectionId: repo.connectionId, executionHostId: repo.executionHostId }
          : null
      ),
    [repo, settings]
  )

  const worktreePath = worktree?.path ?? null
  const [state, setState] = useState<GitGraphHistoryState>({ status: 'idle' })
  const [limit, setLimit] = useState(GIT_GRAPH_DEFAULT_LIMIT)
  const requestSeqRef = useRef(0)

  const result = state.result
  const remoteUnsupported = Boolean(result && result.allRefs !== true)

  const load = useCallback(
    async (requestedLimit: number): Promise<void> => {
      if (!worktreePath) {
        return
      }
      const requestId = requestSeqRef.current + 1
      requestSeqRef.current = requestId
      setState((prev) =>
        prev.result ? { status: 'refreshing', result: prev.result } : { status: 'loading' }
      )
      try {
        const connectionId = getConnectionId(worktreeId) ?? undefined
        // Why: route the history read by the repo OWNER host, not the focused runtime.
        const next = await getRuntimeGitHistory(
          { settings: activeRepoSettings, worktreeId, worktreePath, connectionId },
          { limit: requestedLimit, allRefs: true }
        )
        if (requestSeqRef.current !== requestId) {
          return
        }
        setState({ status: 'ready', result: next })
      } catch (error) {
        if (requestSeqRef.current !== requestId) {
          return
        }
        const message =
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.git.graph.useGitGraphHistory.loadFailed',
                'Failed to load the repository graph'
              )
        setState((prev) =>
          prev.result
            ? { status: 'error', result: prev.result, error: message }
            : { status: 'error', error: message }
        )
      }
    },
    [activeRepoSettings, worktreeId, worktreePath]
  )

  // Why: reload only on workspace identity change — refetching on every routed
  // settings identity churn would thrash remote hosts.
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    setLimit(GIT_GRAPH_DEFAULT_LIMIT)
    void loadRef.current(GIT_GRAPH_DEFAULT_LIMIT)
  }, [worktreeId, worktreePath])

  const refresh = useCallback(() => {
    void load(limit)
  }, [limit, load])

  // Old hosts clamp (and old runtime schemas reject) limits above the
  // single-branch ceiling, so cap growth until the allRefs echo confirms.
  const maxLimit = remoteUnsupported ? GIT_HISTORY_MAX_LIMIT : GIT_GRAPH_MAX_LIMIT
  const canLoadMore = Boolean(result?.hasMore) && limit < maxLimit

  const loadMore = useCallback(() => {
    const nextLimit = Math.min(limit * 2, maxLimit)
    if (nextLimit === limit) {
      return
    }
    setLimit(nextLimit)
    void load(nextLimit)
  }, [limit, load, maxLimit])

  return {
    state,
    remoteUnsupported,
    worktreePath,
    activeRepoSettings,
    refresh,
    loadMore,
    canLoadMore
  }
}
