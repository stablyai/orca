import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getConnectionId } from '@/lib/connection-context'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const LINKED_STATUS_POLL_MS = 5_000

export type LinkedWorktreeView = {
  worktree: Worktree
  repo: Repo
  context: RuntimeGitContext
  entries: GitStatusEntry[]
  branch: string | null
  error: string | null
  loaded: boolean
}

type StatusSnapshot = Pick<LinkedWorktreeView, 'entries' | 'branch' | 'error' | 'loaded'>
const NOT_LOADED: StatusSnapshot = { entries: [], branch: null, error: null, loaded: false }

/** Git routing for a worktree outside the active workspace, on its own repo's host. */
export function linkedWorktreeGitContext(worktree: Worktree, repo: Repo): RuntimeGitContext | null {
  const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
  if (!target) {
    return null
  }
  const connectionId = getConnectionId(worktree.id) ?? repo.connectionId ?? undefined
  return {
    target,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    ...(connectionId ? { connectionId } : {})
  }
}

function useLinkedWorktreeTargets(linkedIds: readonly string[]) {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  return useMemo(() => {
    const repoMap = getRepoMapFromState({ repos })
    const worktreeById = new Map(
      getAllWorktreesFromState({ worktreesByRepo }).map((worktree) => [worktree.id, worktree])
    )
    return linkedIds.flatMap((id) => {
      const worktree = worktreeById.get(id)
      const repo = worktree ? repoMap.get(worktree.repoId) : undefined
      const context = worktree && repo ? linkedWorktreeGitContext(worktree, repo) : null
      return worktree && repo && context ? [{ worktree, repo, context }] : []
    })
  }, [linkedIds, repos, worktreesByRepo])
}

/** Poll status for repos linked to the active workspace while Source Control is visible. */
export function useLinkedWorktreeStatus(linkedIds: readonly string[], isVisible: boolean) {
  const targets = useLinkedWorktreeTargets(linkedIds)
  const [statusById, setStatusById] = useState<Record<string, StatusSnapshot>>({})
  const inFlight = useRef(new Set<string>())

  const refreshOne = useCallback(async (context: RuntimeGitContext): Promise<void> => {
    const id = context.worktreeId
    if (!id || inFlight.current.has(id)) {
      return
    }
    inFlight.current.add(id)
    try {
      const result = await getRuntimeGitStatus(context, { includeLineStats: true })
      setStatusById((prev) => ({
        ...prev,
        [id]: {
          entries: result.entries,
          branch: result.branch ?? null,
          error: result.readError ?? null,
          loaded: true
        }
      }))
    } catch (error) {
      setStatusById((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? NOT_LOADED),
          error: error instanceof Error ? error.message : String(error),
          loaded: true
        }
      }))
    } finally {
      inFlight.current.delete(id)
    }
  }, [])

  const refreshAll = useCallback(() => {
    for (const { context } of targets) {
      void refreshOne(context)
    }
  }, [refreshOne, targets])

  useEffect(() => {
    if (!isVisible || targets.length === 0) {
      return
    }
    refreshAll()
    const timer = window.setInterval(refreshAll, LINKED_STATUS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [isVisible, refreshAll, targets.length])

  const views: LinkedWorktreeView[] = targets.map((target) => ({
    ...target,
    ...(statusById[target.worktree.id] ?? NOT_LOADED),
    branch: statusById[target.worktree.id]?.branch ?? target.worktree.branch ?? null
  }))
  return { views, refreshOne }
}
