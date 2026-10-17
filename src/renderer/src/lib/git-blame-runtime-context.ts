import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

/** Routes blame reads to the worktree's owner; null when its path or owner can't be resolved. */
export function resolveGitBlameRuntimeContext(worktreeId: string): RuntimeGitContext | null {
  const state = useAppStore.getState()
  const worktree = findWorktreeById(state.worktreesByRepo, worktreeId)
  const worktreePath =
    worktree?.path ?? splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null
  const target = getRuntimeTargetForWorktreeOwner(state, worktreeId)
  if (!worktreePath || !target) {
    return null
  }
  return {
    target,
    worktreeId,
    worktreePath,
    connectionId: getConnectionId(worktreeId) ?? undefined
  }
}
