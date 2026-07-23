import { getConnectionIdFromState, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'
import type { useAppStore } from '@/store'

export function getTabEntryAllowAbsolutePaths(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): boolean {
  if (!isWorktreeConnectionResolved(worktreeId)) {
    return false
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return false
  }
  const worktree = state.getKnownWorktreeById(worktreeId)
  try {
    const runtimeContext = getEditorFileOperationContext(
      state,
      { worktreeId },
      worktree?.path ?? null
    )
    return !isLocalPathOpenBlocked(runtimeContext.settings, { connectionId })
  } catch {
    return false
  }
}
