import { useAppStore } from '../../index'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { selectKnownWorktreeById, selectFileListWorktree } from './known-worktree-selection'

export const useActiveWorktreeId = () => useAppStore((s) => s.activeWorktreeId)

export const useWorktreeById = (worktreeId: string | null, executionHostId?: ExecutionHostId) =>
  useAppStore((s) => selectKnownWorktreeById(s, worktreeId, executionHostId))

export const useFileListWorktree = (worktreeId: string | null) =>
  useAppStore((s) => selectFileListWorktree(s, worktreeId))

export const useActiveWorktree = () => {
  const activeWorktreeId = useActiveWorktreeId()
  return useAppStore((s) =>
    activeWorktreeId
      ? (s.getKnownWorktreeById(activeWorktreeId, s.activeWorkspaceExecutionHostId ?? undefined) ??
        null)
      : null
  )
}
