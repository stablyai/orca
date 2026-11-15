import { useEffect } from 'react'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

export function useSourceControlUpstreamStatusFetch({
  activeRepoTarget,
  activeWorktree,
  activeWorktreeId,
  fetchUpstreamStatus,
  isBranchVisible,
  isFolder,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  fetchUpstreamStatus: SourceControlStoreActions['fetchUpstreamStatus']
  isBranchVisible: boolean
  isFolder: boolean
  worktreePath: string | null
}): void {
  const scope = useSourceControlScope()
  useEffect(() => {
    // Avoid Git subprocesses while the sidebar is hidden.
    if (!activeWorktreeId || !worktreePath || isFolder || !isBranchVisible) {
      return
    }
    const connectionId = sourceControlConnectionId(scope, activeWorktreeId)
    void fetchUpstreamStatus(
      activeWorktreeId,
      worktreePath,
      connectionId,
      activeWorktree?.pushTarget,
      { runtimeTarget: activeRepoTarget }
    )
  }, [
    scope,
    activeRepoTarget,
    activeWorktree?.pushTarget,
    activeWorktreeId,
    fetchUpstreamStatus,
    isBranchVisible,
    isFolder,
    worktreePath
  ])
}
