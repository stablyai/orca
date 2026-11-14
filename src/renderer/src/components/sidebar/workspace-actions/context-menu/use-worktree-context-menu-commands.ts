import { useCallback } from 'react'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../../../shared/execution-host'
import { getRepoWorkspaceCreationTargetHint } from '@/lib/workspace/creation/project-host-workspace-target'
import { resolveReviewRepository } from '@/lib/source-control/review/review-owner'
import {
  createWorktreeContextMenuDeleteIntent,
  deferWorktreeContextMenuDeleteIntent
} from './worktree-context-menu-delete-intent'
import { runSleepWorktrees } from '../sleep/sleep-worktree-flow'
import { collectTwinHostsAlsoSlept } from '../sleep/sleep-twin-confirmation'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { formatClipboardFilePath } from '@/lib/clipboard/clipboard-file-path'
import { getWorktreeRowLocalPathOpenOwner } from '@/lib/workspace/ownership/worktree-row-open-in-owner'
import {
  canCreateChildWorktree,
  planWorkspaceStatusAssignment,
  preserveDeleteSiblingPosition
} from './worktree-context-menu-policy'
import type { useAppStore } from '@/store/index'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'

function resolveChildWorktreeRepository(repos: readonly Repo[], worktree: Worktree): Repo | null {
  return resolveReviewRepository(repos, {
    ...worktree,
    // Unstamped clicked rows are local, regardless of the active workspace's owner.
    hostId:
      worktree.hostId ??
      (worktree.runtimeOwnerEnvironmentId?.trim() ? undefined : LOCAL_EXECUTION_HOST_ID)
  })
}

export function useWorktreeContextMenuCommands(args: {
  activeContextWorktrees: readonly Worktree[]
  batchDeleteWorktrees: readonly Worktree[]
  createGroupDialogActiveRef: React.MutableRefObject<boolean>
  createProjectGroup: ReturnType<typeof useAppStore.getState>['createProjectGroup']
  folderWorkspaceId: string | null
  getState: () => ReturnType<typeof useAppStore.getState>
  isMultiContext: boolean
  moveProjectToGroup: ReturnType<typeof useAppStore.getState>['moveProjectToGroup']
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: string) => void
  openModal: ReturnType<typeof useAppStore.getState>['openModal']
  repo: Repo | null | undefined
  scopeRef: React.RefObject<HTMLDivElement | null>
  setCreateGroupDialogOpen: (open: boolean) => void
  setMenuOpenState: (open: boolean) => void
  setWorkspaceUnreadByUser: ReturnType<typeof useAppStore.getState>['setWorkspaceUnreadByUser']
  setWorktreesPinnedAndReveal: ReturnType<
    typeof useAppStore.getState
  >['setWorktreesPinnedAndReveal']
  showsUnread: boolean
  sleepableWorktrees: readonly Worktree[]
  subtreeSleepableWorktrees: readonly Worktree[]
  updateWorktreeMeta: ReturnType<typeof useAppStore.getState>['updateWorktreeMeta']
  validParent: Worktree | null
  worktree: Worktree
  statusesForWorktree: (worktree: Worktree) => readonly WorkspaceStatusDefinition[]
}) {
  const handleCopyPath = useCallback(() => {
    const owner = getWorktreeRowLocalPathOpenOwner(
      args.getState(),
      args.worktree,
      args.repo?.connectionId
    )
    window.api.ui.writeClipboardText(formatClipboardFilePath(args.worktree.path, owner))
  }, [args])
  const handleCopyName = useCallback(() => {
    window.api.ui.writeClipboardText(resolveWorktreeDisplayName(args.worktree))
  }, [args])
  const handleToggleRead = useCallback(() => {
    args.setWorkspaceUnreadByUser(
      args.worktree.id,
      !args.showsUnread,
      args.worktree.hostId ?? 'local'
    )
  }, [args])
  const handleTogglePin = useCallback(() => {
    args.setWorktreesPinnedAndReveal([args.worktree], !args.worktree.isPinned)
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
      const group = await args.createProjectGroup(name, getRepoExecutionHostId(args.repo))
      if (group) {
        await args.moveProjectToGroup(args.repo, group.id)
      }
    },
    [args]
  )
  const handleMoveProjectToGroup = useCallback(
    (groupId: string) => {
      if (!args.repo || args.repo.projectGroupId === groupId) {
        return
      }
      void args.moveProjectToGroup(args.repo, groupId)
    },
    [args]
  )
  const handleRemoveProjectFromGroup = useCallback(() => {
    if (args.repo) {
      void args.moveProjectToGroup(args.repo, null)
    }
  }, [args])
  const handleAssignWorkspaceStatus = useCallback(
    (status: string) => {
      args.setMenuOpenState(false)
      const plan = planWorkspaceStatusAssignment(
        args.activeContextWorktrees,
        status,
        args.statusesForWorktree,
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
  const handleNewChildWorktree = useCallback(() => {
    const state = args.getState()
    const repo = resolveChildWorktreeRepository(state.repos, args.worktree)
    if (!repo || !canCreateChildWorktree({ ...args, repo })) {
      return
    }
    args.setMenuOpenState(false)
    args.openModal('new-workspace-composer', {
      initialRepoId: repo.id,
      initialWorkspaceTarget: getRepoWorkspaceCreationTargetHint(repo, state.projectHostSetups),
      initialParentWorktreeId: args.worktree.id,
      telemetrySource: 'sidebar'
    })
  }, [args])
  const sleepWorktreesAfterMenuClose = useCallback(
    (worktrees: readonly Worktree[]) => {
      args.setMenuOpenState(false)
      const worktreeIds = worktrees.map((worktree) => worktree.id)
      // Why confirm: a twin's copies share one id, so this also sleeps copies the user didn't pick.
      const hostIds = collectTwinHostsAlsoSlept(args.getState(), worktrees)
      if (hostIds.length > 0) {
        args.openModal('confirm-sleep-twin', { worktreeIds, hostIds })
        return
      }
      window.setTimeout(() => void runSleepWorktrees(worktreeIds), 50)
    },
    [args]
  )
  const handleCloseTerminals = useCallback(() => {
    sleepWorktreesAfterMenuClose(args.sleepableWorktrees)
  }, [args.sleepableWorktrees, sleepWorktreesAfterMenuClose])
  const handleSleepSubtree = useCallback(() => {
    sleepWorktreesAfterMenuClose(args.subtreeSleepableWorktrees)
  }, [args.subtreeSleepableWorktrees, sleepWorktreesAfterMenuClose])
  // Suspend VM with active descendants: this workspace sleeps too, even idle, so its VM suspends
  // once every child session on it has stopped.
  const handleSleepSubtreeWithVm = useCallback(() => {
    sleepWorktreesAfterMenuClose([
      args.worktree,
      ...args.subtreeSleepableWorktrees.filter((target) => target.id !== args.worktree.id)
    ])
  }, [args.worktree, args.subtreeSleepableWorktrees, sleepWorktreesAfterMenuClose])
  const handleDelete = useCallback(() => {
    const restoreSidebarPosition = preserveDeleteSiblingPosition(args.scopeRef.current)
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
    if (args.validParent) {
      // A parent on another machine shares no host with the child; open the parent's own row.
      activateAndRevealWorktree(args.validParent.id, {
        navigationIntent: 'user-open',
        executionHostId: args.validParent.hostId
      })
    }
  }, [args.validParent])
  return {
    canCreateChildWorktree: canCreateChildWorktree({
      ...args,
      repo: resolveChildWorktreeRepository(args.getState().repos, args.worktree)
    }),
    handleAssignWorkspaceStatus,
    handleCloseTerminals,
    handleCopyName,
    handleCopyPath,
    handleCreateGroupDialogOpenChange,
    handleCreateGroupFromRepo,
    handleDelete,
    handleMoveProjectToGroup,
    handleNewChildWorktree,
    handleOpenParent,
    handleRemoveProjectFromGroup,
    handleRename,
    handleSleepSubtree,
    handleSleepSubtreeWithVm,
    handleSubmitNewProjectGroup,
    handleTogglePin,
    handleToggleRead
  }
}
