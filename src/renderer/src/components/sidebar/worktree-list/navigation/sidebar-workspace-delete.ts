import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { resolveWorktreeOperationRouteForHost } from '@/lib/workspace/ownership/worktree-operation-route'
import { getWorktreeExecutionHostId } from '../../../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repo-types'
import { isContextWorktreeDeletable } from '../../workspace-actions/context-menu/worktree-context-menu-policy'
import {
  createWorktreeContextMenuDeleteIntent,
  type WorktreeContextMenuDeleteIntent
} from '../../workspace-actions/context-menu/worktree-context-menu-delete-intent'
import { resolveSshWorkspaceForget } from '../../workspace-actions/deletion/ssh-workspace-forget-resolution'
import { getDeleteStateForWorktreeHost } from '../../workspace-actions/deletion/worktree-delete-state-host-match'

export function resolveSidebarWorkspaceDeleteIntent(args: {
  selectedWorktrees: readonly Worktree[]
  focusedWorktree: Worktree | null
  repoMap: ReadonlyMap<string, Repo>
}): WorktreeContextMenuDeleteIntent | null {
  const { selectedWorktrees, focusedWorktree, repoMap } = args
  const state = useAppStore.getState()
  if (
    selectedWorktrees.length === 0 ||
    selectedWorktrees.some(
      (item) => getDeleteStateForWorktreeHost(item, state.deleteStateByWorktreeId)?.isDeleting
    )
  ) {
    return null
  }
  const deletable = selectedWorktrees.filter((item) =>
    isContextWorktreeDeletable(item, repoMap.get(item.repoId))
  )
  const isMultiContext = selectedWorktrees.length > 1
  if (isMultiContext && deletable.length === 0) {
    return null
  }
  const needsSingleOperation =
    deletable.length > 1 &&
    !isPairedWebClientWindow() &&
    deletable.some(
      (item) =>
        resolveSshWorkspaceForget({
          route: resolveWorktreeOperationRouteForHost(
            state,
            item.id,
            getWorktreeExecutionHostId(item, repoMap.get(item.repoId))
          ),
          sshTargetLabels: state.sshTargetLabels
        }).kind !== 'not-ssh'
    )
  const single = needsSingleOperation
    ? focusedWorktree &&
      deletable.find(
        (item) => getWorktreeHostIdentity(item) === getWorktreeHostIdentity(focusedWorktree)
      )
    : selectedWorktrees[0]
  if (!single) {
    return null
  }
  const scope = parseWorkspaceKey(single.id)
  const folderWorkspaceId = scope?.type === 'folder' ? scope.folderWorkspaceId : undefined
  if (
    (!isMultiContext || needsSingleOperation) &&
    !folderWorkspaceId &&
    !isContextWorktreeDeletable(single, repoMap.get(single.repoId))
  ) {
    return null
  }
  return createWorktreeContextMenuDeleteIntent({
    worktree: single,
    batchDeleteWorktrees: deletable,
    isMultiContext: isMultiContext && !needsSingleOperation,
    folderWorkspaceId
  })
}
