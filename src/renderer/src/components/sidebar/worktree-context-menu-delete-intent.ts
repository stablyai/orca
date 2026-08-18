import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { runWorktreeBatchDelete, runWorktreeDelete } from './delete-worktree-flow'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import type { Worktree } from '../../../../shared/worktree/types'

export type WorktreeContextMenuDeleteIntent =
  | { kind: 'worktree'; worktree: WorktreeDeleteIdentity }
  | { kind: 'batch'; worktrees: readonly WorktreeDeleteIdentity[] }
  | { kind: 'folder'; folderWorkspaceId: string }

export function createWorktreeContextMenuDeleteIntent(args: {
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'hostId'>
  batchDeleteWorktrees: readonly Pick<Worktree, 'id' | 'instanceId' | 'hostId'>[]
  isMultiContext: boolean
  folderWorkspaceId?: string
}): WorktreeContextMenuDeleteIntent {
  if (args.isMultiContext) {
    return {
      kind: 'batch',
      worktrees: args.batchDeleteWorktrees.map(({ id, instanceId, hostId }) => ({
        id,
        instanceId,
        hostId
      }))
    }
  }
  if (args.folderWorkspaceId) {
    return { kind: 'folder', folderWorkspaceId: args.folderWorkspaceId }
  }
  const { id, instanceId, hostId } = args.worktree
  return { kind: 'worktree', worktree: { id, instanceId, hostId } }
}

export function runWorktreeContextMenuDeleteIntent(intent: WorktreeContextMenuDeleteIntent): void {
  if (intent.kind === 'batch') {
    runWorktreeBatchDelete(intent.worktrees)
    return
  }
  if (intent.kind === 'worktree') {
    runWorktreeDelete(intent.worktree.id, {
      expectedInstanceId: intent.worktree.instanceId,
      ...(intent.worktree.hostId ? { expectedHostId: intent.worktree.hostId } : {})
    })
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
