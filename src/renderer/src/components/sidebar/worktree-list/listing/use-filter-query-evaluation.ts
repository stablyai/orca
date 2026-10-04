import { useCallback, useDeferredValue, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  buildSidebarFilterQueryDocumentIndex,
  evaluateSidebarFilterQueryText,
  type SidebarFilterQueryEvaluation
} from '../../sidebar-filter-query-evaluation'
import { parseWorkspaceFilterQuery } from '../../workspace-filter-query'
import { buildWorkspaceStatusLabelById } from '../../workspace-filter-subject'

/**
 * Turns the typed sidebar query into a pipeline-ready evaluation. The palette
 * index is memoized on the worktree catalog so a keystroke only reruns the
 * match; the query itself is deferred so the caret never waits on the list.
 */
export function useSidebarFilterQueryEvaluation(args: {
  query: string
  allWorktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  hostLabelById: ReadonlyMap<string, string>
  defaultHostId: ExecutionHostId
}): SidebarFilterQueryEvaluation | null {
  const { allWorktrees, repoMap, hostLabelById, defaultHostId } = args
  const deferredQuery = useDeferredValue(args.query)
  const parsed = useMemo(() => parseWorkspaceFilterQuery(deferredQuery), [deferredQuery])
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const statusLabelById = useMemo(
    () => buildWorkspaceStatusLabelById(workspaceStatuses),
    [workspaceStatuses]
  )
  const resolveHostId = useCallback(
    (worktree: Worktree, repo: Repo | undefined) =>
      getWorktreeExecutionHostId(worktree, repo, defaultHostId),
    [defaultHostId]
  )
  // Why lazy: most sessions never type a query, and the index normalizes every
  // field of every worktree.
  const index = useMemo(
    () =>
      parsed.isActive
        ? buildSidebarFilterQueryDocumentIndex({
            worktrees: allWorktrees,
            repoMap,
            hostLabelById,
            resolveHostId
          })
        : null,
    [allWorktrees, hostLabelById, parsed.isActive, repoMap, resolveHostId]
  )
  return useMemo(() => {
    if (!parsed.isActive || !index) {
      return null
    }
    return {
      parsed,
      verdicts: evaluateSidebarFilterQueryText({
        parsed,
        worktrees: allWorktrees,
        repoMap,
        index
      }),
      hostLabelById,
      statusLabelById
    }
  }, [allWorktrees, hostLabelById, index, parsed, repoMap, statusLabelById])
}
