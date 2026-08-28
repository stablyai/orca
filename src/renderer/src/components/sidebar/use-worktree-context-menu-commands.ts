import { useCallback } from 'react'
import type { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import {
  createWorktreeContextMenuDeleteIntent,
  deferWorktreeContextMenuDeleteIntent
} from './worktree-context-menu-delete-intent'
import { runSleepWorktrees } from './sleep-worktree-flow'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import {
  planWorkspaceStatusAssignment,
  preserveDeleteSiblingPosition
} from './worktree-context-menu-policy'

export function useWorktreeContextMenuCommands(args: {
  activeContextWorktrees: readonly Worktree[]
  batchDeleteWorktrees: readonly Worktree[]
  createGroupDialogActiveRef: React.MutableRefObject<boolean>
  createProjectGroup: ReturnType<typeof useAppStore.getState>['createProjectGroup']
  folderWorkspaceId: string | null
  isMultiContext: boolean
  moveProjectToGroup: ReturnType<typeof useAppStore.getState>['moveProjectToGroup']
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: string) => void
  openModal: ReturnType<typeof useAppStore.getState>['openModal']
  repo: Repo | null | undefined
  scopeRef: React.RefObject<HTMLDivElement | null>
  setCreateGroupDialogOpen: (open: boolean) => void
  setMenuOpenState: (open: boolean) => void
  setWorktreesPinnedAndReveal: ReturnType<
    typeof useAppStore.getState
  >['setWorktreesPinnedAndReveal']
  sleepableWorktrees: readonly Worktree[]
  subtreeSleepableWorktrees: readonly Worktree[]
  updateWorktreeMeta: ReturnType<typeof useAppStore.getState>['updateWorktreeMeta']
  validParentWorktreeId: string | null
  worktree: Worktree
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}) {
  const handleCopyPath = useCallback(() => {
    window.api.ui.writeClipboardText(args.worktree.path)
  }, [args])
  const handleToggleRead = useCallback(() => {
    args.updateWorktreeMeta(
      args.worktree.id,
      { isUnread: !args.worktree.isUnread },
      { executionHostId: args.worktree.hostId ?? 'local' }
    )
  }, [args])
  const handleTogglePin = useCallback(() => {
    args.setWorktreesPinnedAndReveal([args.worktree.id], !args.worktree.isPinned)
  }, [args])
  const handleCreateGroupFromRepo = useCallback(() => {
    if (!args.repo) {
      return
    }
    args.createGroupDialogActiveRef.current = true
    args.setCreateGroupDialogOpen(true)
  }, [args])
  const handleCreateGroupDialogOpenChange = useCallback(
    (open: boolean) => {
      args.createGroupDialogActiveRef.current = open
      args.setCreateGroupDialogOpen(open)
    },
    [args]
  )
  const handleSubmitNewProjectGroup = useCallback(
    async (name: string) => {
      if (!args.repo) {
        return
      }
      const group = await args.createProjectGroup(name)
      if (group) {
        await args.moveProjectToGroup(args.repo.id, group.id)
      }
    },
    [args]
  )
  const handleMoveProjectToGroup = useCallback(
    (groupId: string) => {
      if (!args.repo || args.repo.projectGroupId === groupId) {
        return
      }
      void args.moveProjectToGroup(args.repo.id, groupId)
    },
    [args]
  )
  const handleRemoveProjectFromGroup = useCallback(() => {
    if (args.repo) {
      void args.moveProjectToGroup(args.repo.id, null)
    }
  }, [args])
  const handleAssignWorkspaceStatus = useCallback(
    (status: string) => {
      args.setMenuOpenState(false)
      const plan = planWorkspaceStatusAssignment(
        args.activeContextWorktrees,
        status,
        args.workspaceStatuses,
        Boolean(args.onAssignWorkspaceStatus)
      )
      if (plan.kind === 'board-sync') {
        args.onAssignWorkspaceStatus?.(plan.worktreeIds, status)
        return
      }
      const localWriteIds = new Set(plan.localWriteIds)
      void Promise.all(
        args.activeContextWorktrees
          .filter((worktree) => localWriteIds.has(worktree.id))
          .map((worktree) =>
            args.updateWorktreeMeta(
              worktree.id,
              { workspaceStatus: status },
              { executionHostId: worktree.hostId ?? 'local' }
            )
          )
      )
    },
    [args]
  )
  const handleRename = useCallback(() => {
    args.openModal('edit-meta', {
      worktreeId: args.worktree.id,
      repoId: args.worktree.repoId,
      executionHostId: args.worktree.hostId,
      currentDisplayName: args.worktree.displayName,
      currentIssue: args.worktree.linkedIssue,
      currentPR: args.worktree.linkedPR,
      currentComment: args.worktree.comment,
      focus: 'displayName'
    })
  }, [args])
  const sleepWorktreesAfterMenuClose = useCallback(
    (worktreeIds: string[]) => {
      args.setMenuOpenState(false)
      window.setTimeout(() => void runSleepWorktrees(worktreeIds), 50)
    },
    [args]
  )
  const handleCloseTerminals = useCallback(() => {
    sleepWorktreesAfterMenuClose(args.sleepableWorktrees.map((item) => item.id))
  }, [args.sleepableWorktrees, sleepWorktreesAfterMenuClose])
  const handleSleepSubtree = useCallback(() => {
    sleepWorktreesAfterMenuClose(args.subtreeSleepableWorktrees.map((item) => item.id))
  }, [args.subtreeSleepableWorktrees, sleepWorktreesAfterMenuClose])
  const handleDelete = useCallback(() => {
    const restoreSidebarPosition = preserveDeleteSiblingPosition(args.scopeRef.current)
    args.scopeRef.current
      ?.closest('[data-worktree-sidebar]')
      ?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
    const intent = createWorktreeContextMenuDeleteIntent({
      worktree: args.worktree,
      batchDeleteWorktrees: args.batchDeleteWorktrees,
      isMultiContext: args.isMultiContext,
      ...(args.folderWorkspaceId ? { folderWorkspaceId: args.folderWorkspaceId } : {})
    })
    deferWorktreeContextMenuDeleteIntent(intent, restoreSidebarPosition)
    args.setMenuOpenState(false)
  }, [args])
  const handleOpenParent = useCallback(() => {
    if (args.validParentWorktreeId) {
      activateAndRevealWorktree(args.validParentWorktreeId)
    }
  }, [args.validParentWorktreeId])
  return {
    handleAssignWorkspaceStatus,
    handleCloseTerminals,
    handleCopyPath,
    handleCreateGroupDialogOpenChange,
    handleCreateGroupFromRepo,
    handleDelete,
    handleMoveProjectToGroup,
    handleOpenParent,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleSubmitNewProjectGroup,
    handleTogglePin,
    handleToggleRead
  }
}
