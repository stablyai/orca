import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'

export type WorktreeContextMenuDeleteIntent =
  | { kind: 'worktree'; worktree: WorktreeDeleteIdentity }
  | { kind: 'batch'; worktrees: readonly WorktreeDeleteIdentity[] }
  | { kind: 'folder'; folderWorkspaceId: string }

export function runWorktreeContextMenuDeleteIntent(intent: WorktreeContextMenuDeleteIntent): void {
  if (intent.kind === 'batch') {
    runWorktreeBatchDelete(intent.worktrees)
    return
  }
  if (intent.kind === 'worktree') {
    runWorktreeDelete(intent.worktree.id, { expectedInstanceId: intent.worktree.instanceId })
    return
  }
  const state = useAppStore.getState()
  void state.deleteFolderWorkspace(intent.folderWorkspaceId).then((deleted) => {
    const current = useAppStore.getState()
    if (deleted && current.activeWorktreeId === folderWorkspaceKey(intent.folderWorkspaceId)) {
      current.setActiveWorktree(null)
    }
  })
}

export function deferWorktreeContextMenuDeleteIntent(
  intent: WorktreeContextMenuDeleteIntent,
  onDispatched?: () => void,
  defer: (callback: () => void) => void = (callback) => window.setTimeout(callback, 0)
): void {
  defer(() => {
    runWorktreeContextMenuDeleteIntent(intent)
    onDispatched?.()
  })
}
