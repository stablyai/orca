import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { getRepoOwnerRoutedSettings } from '@/lib/repo-runtime-owner'
import { getRuntimeGitHistory, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { GIT_HISTORY_MAX_LIMIT, type GitHistoryResult } from '../../../../shared/git-history'
import { translate } from '@/i18n/i18n'

export type GitGraphHistoryState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

export type UseGitGraphHistory = {
  state: GitGraphHistoryState
  refresh: () => void
  context: RuntimeGitContext | null
}

// Loads the repo-wide (all refs) history for the Git Graph pane. Routes by the
// repo OWNER host like Source Control, and always requests the MAX limit so the
// graph isn't silently capped at the linear default.
export function useGitGraphHistory(worktreeId: string): UseGitGraphHistory {
  const worktree = useWorktreeById(worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null)
  const settings = useAppStore((s) => s.settings)
  const worktreePath = worktree?.path ?? null

  const [state, setState] = useState<GitGraphHistoryState>({ status: 'idle' })
  // Bumped on Refresh; also re-runs the load when worktree/path changes.
  const [reloadToken, setReloadToken] = useState(0)
  const requestIdRef = useRef(0)

  // Why: memoize the routed context so its identity only changes when a routing
  // input does. A fresh object each render would (a) re-fire the fetch effect on
  // every render and (b) rebuild the consumer's commit-action callbacks, which
  // depend on context.settings, on every render.
  const context = useMemo<RuntimeGitContext | null>(() => {
    if (!worktreePath) {
      return null
    }
    return {
      settings: getRepoOwnerRoutedSettings(settings, repo ?? null),
      worktreeId,
      worktreePath,
      connectionId: getConnectionId(worktreeId) ?? undefined
    }
  }, [repo, settings, worktreeId, worktreePath])

  useEffect(() => {
    // Bump before the null-check so a fetch still in flight from a prior
    // worktree can't resolve and overwrite this 'idle' state once it clears.
    const requestId = (requestIdRef.current += 1)
    const ctx = context
    if (!ctx) {
      setState({ status: 'idle' })
      return
    }
    setState((prev) =>
      prev.status === 'ready' || prev.status === 'refreshing'
        ? { status: 'refreshing', result: prev.result }
        : { status: 'loading' }
    )
    getRuntimeGitHistory(ctx, { allRefs: true, limit: GIT_HISTORY_MAX_LIMIT })
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setState({ status: 'ready', result })
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setState({
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.git.graph.useGitGraphHistory.3d9c2e7b41',
                  'Failed to load git graph'
                )
        })
      })
  }, [context, reloadToken])

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  return { state, refresh, context }
}
