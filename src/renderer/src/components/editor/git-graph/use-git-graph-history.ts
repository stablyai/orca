import { useEffect } from 'react'
import { useStore } from 'zustand'
import { useAppStore } from '@/store'
import { useGitGraphScope } from '@/lib/git-graph-tab'
import { gitGraphHistoryForTab } from './git-graph-history-controller'
import type {
  GitHistoryRefs,
  GitHistoryResult
} from '../../../../../shared/git/history/git-history-types'

export function gitGraphFilterSupported(result?: GitHistoryResult): boolean | undefined {
  return result ? result.refs !== undefined : undefined
}

export function useGitGraphHistory(worktreeId: string) {
  const filter = useAppStore((state) => state.gitGraphFiltersByWorktree?.[worktreeId] ?? 'all')
  const controller = gitGraphHistoryForTab(worktreeId)
  const scope = useGitGraphScope(worktreeId, controller.executionHostId)
  const view = useStore(controller.view)
  useEffect(() => controller.attach(), [controller])
  const changeFilter = (refs: GitHistoryRefs) =>
    useAppStore.setState((state) => ({
      gitGraphFiltersByWorktree: {
        ...state.gitGraphFiltersByWorktree,
        [worktreeId]: Array.isArray(refs) ? [...new Set(refs)].sort() : refs
      }
    }))
  return {
    ...view,
    filter,
    scope,
    controller,
    changeFilter,
    refresh: controller.refresh,
    loadMore: controller.loadMore,
    reveal: controller.reveal
  }
}
