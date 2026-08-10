import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'

export type WorktreeContextMenuDeleteIntent =
  | {
      kind: 'worktree'
      worktreeId: string
      worktreeInstanceId?: string
    }
  | { kind: 'batch'; worktreeIds: readonly string[] }
  | { kind: 'folder'; folderWorkspaceId: string }

export function runWorktreeContextMenuDeleteIntent(intent: WorktreeContextMenuDeleteIntent): void {
  if (intent.kind === 'batch') {
    runWorktreeBatchDelete(intent.worktreeIds)
    return
  }
  if (intent.kind === 'worktree') {
    runWorktreeDelete(intent.worktreeId, { expectedInstanceId: intent.worktreeInstanceId })
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
