import { useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'

/** Keeps the upstream ahead/behind status for the visible branch fresh. */
export function useSourceControlUpstreamStatusFetch({
  activeRepoSettings,
  activeWorktree,
  activeWorktreeId,
  fetchUpstreamStatus,
  isBranchVisible,
  isFolder,
  worktreePath
}: {
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  fetchUpstreamStatus: SourceControlStoreActions['fetchUpstreamStatus']
  isBranchVisible: boolean
  isFolder: boolean
  worktreePath: string | null
}): void {
  useEffect(() => {
    // Why: gate on isBranchVisible so we don't spawn git processes while the sidebar is closed.
    if (!activeWorktreeId || !worktreePath || isFolder || !isBranchVisible) {
      return
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? undefined
    void fetchUpstreamStatus(
      activeWorktreeId,
      worktreePath,
      connectionId,
      activeWorktree?.pushTarget,
      { runtimeTargetSettings: activeRepoSettings }
    )
  }, [
    activeRepoSettings,
    activeWorktree?.pushTarget,
    activeWorktreeId,
    fetchUpstreamStatus,
    isBranchVisible,
    isFolder,
    worktreePath
  ])
}
