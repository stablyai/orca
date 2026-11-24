import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { resolveWorktreeOperationRouteForHost } from '@/lib/workspace/ownership/worktree-operation-route'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import { getRenderedWorkspaceRowsInSidebarOrder } from './worktree-sidebar-row-preference'
import { getCyclableRowIdentity } from './worktree-keyboard-cycle'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/selection/active-workspace'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isContextWorktreeDeletable } from '../../workspace-actions/context-menu/worktree-context-menu-policy'
import {
  createWorktreeContextMenuDeleteIntent,
  type WorktreeContextMenuDeleteIntent
} from '../../workspace-actions/context-menu/worktree-context-menu-delete-intent'
import { resolveSshWorkspaceForget } from '../../workspace-actions/deletion/ssh-workspace-forget-resolution'
import { getDeleteStateForWorktreeHost } from '../../workspace-actions/deletion/worktree-delete-state-host-match'
import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'

// Why: with nothing selected the focused list treats the open workspace's row as current (arrows, aria-activedescendant).
export function getSidebarWorkspaceDeleteTargets(args: {
  selectedWorktrees: readonly Worktree[]
  rows: readonly HostSectionRow[]
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}): readonly Worktree[] {
  const { activeWorktreeId, activeWorkspaceExecutionHostId } = args
  if (args.selectedWorktrees.length > 0 || activeWorktreeId === null) {
    return args.selectedWorktrees
  }
  const active = { worktreeId: activeWorktreeId, hostId: activeWorkspaceExecutionHostId }
  const activeIdentity = activeWorkspaceExecutionHostId
    ? composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
    : null
  const matches = getRenderedWorkspaceRowsInSidebarOrder(
    args.rows,
    args.pinnedDisplayPolicy
  ).filter(
    (row) =>
      getCyclableRowIdentity(row) === activeIdentity ||
      isActiveSidebarWorkspace(row.worktree, active)
  )
  // A host-less activation can match same-id workspaces on several hosts; never guess which to delete.
  return new Set(matches.map(getCyclableRowIdentity)).size === 1 ? [matches[0].worktree] : []
}

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
    deletable.some((item) => {
      const matchingRepos = getIndexedReposById(state.repos, item.repoId)
      const hostId = item.hostId
      const repo = hostId
        ? matchingRepos.find((repo) => repoMatchesHostIdentity(repo, item.repoId, hostId))
        : matchingRepos.length === 1
          ? matchingRepos[0]
          : undefined
      return (
        resolveSshWorkspaceForget({
          route: resolveWorktreeOperationRouteForHost(
            state,
            item.id,
            getWorktreeExecutionHostId(item, repo ?? undefined)
          ),
          sshTargetLabels: state.sshTargetLabels
        }).kind !== 'not-ssh'
      )
    })
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
