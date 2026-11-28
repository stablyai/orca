import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { ConfirmationDialogContextValue } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store/index'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui/ui-slice-contract-core'
import { isWorktreeInHiddenProject } from '@/lib/workspace/activation/worktree-activation-sidebar-filters'
import { runWithFinally } from '@/lib/run-with-finally'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getKnownSidebarWorktreeById } from './folder-reveal'
import { isPendingRevealOwnedOutsideProjects } from './pending-reveal-inputs'
import {
  confirmRevealHiddenWorkspace,
  workspacePassesFilters
} from './hidden-workspace-reveal-confirmation'

export type OpenedWorkspaceRevealPromptArgs = {
  visibleWorktrees: readonly Worktree[]
  visibleFolderWorkspaces: readonly FolderWorkspace[]
  currentSidebarWorktreeId: string | null
  currentSidebarExecutionHostId: ExecutionHostId | null
  worktreeMap: Map<string, Worktree>
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  hasFilters: boolean
  revealWorkspaceFilters: (worktree: Worktree) => void
}

/** The active workspace a pending reveal targets, when only the sidebar filters keep its row out. */
function findFilterHiddenActiveTarget(
  args: OpenedWorkspaceRevealPromptArgs,
  request: PendingSidebarWorktreeReveal
): Worktree | null {
  const activeId = args.currentSidebarWorktreeId
  if (!args.hasFilters || !activeId || request.rowKey) {
    return null
  }
  if (isPendingRevealOwnedOutsideProjects(request)) {
    return null
  }
  const lookup = (id: string, hostId: ExecutionHostId | null | undefined): Worktree | null =>
    getKnownSidebarWorktreeById(id, args.worktreeMap, args.folderWorkspaces, args.worktrees, hostId)
  const active = lookup(activeId, args.currentSidebarExecutionHostId)
  const target = lookup(
    request.worktreeId,
    request.executionHostId ?? args.currentSidebarExecutionHostId
  )
  // Host-qualified: a same-id workspace on another host is a different row.
  if (
    !active ||
    !target ||
    target.isArchived ||
    getWorktreeHostIdentity(active) !== getWorktreeHostIdentity(target) ||
    isWorktreeInHiddenProject(target)
  ) {
    return null
  }
  return workspacePassesFilters(target, args.visibleWorktrees, args.visibleFolderWorkspaces)
    ? null
    : target
}

// Opening a workspace (Cmd+J, notification, dashboard, task link) queues its reveal; when the filters
// hide its row, ask as "Reveal current" does instead of leaving the reveal waiting silently.
export function useOpenedWorkspaceRevealPrompt(
  args: OpenedWorkspaceRevealPromptArgs,
  confirm: ConfirmationDialogContextValue,
  confirmationPendingRef: RefObject<boolean>
): void {
  const pendingRevealWorktree = useAppStore((s) => s.pendingRevealWorktree)
  const promptedRequest = useRef<PendingSidebarWorktreeReveal | null>(null)
  const latestArgs = useRef(args)
  useLayoutEffect(() => {
    latestArgs.current = args
  })

  useEffect(() => {
    const request = pendingRevealWorktree
    if (!request || promptedRequest.current === request || confirmationPendingRef.current) {
      return
    }
    if (!findFilterHiddenActiveTarget(latestArgs.current, request)) {
      return
    }
    promptedRequest.current = request
    confirmationPendingRef.current = true
    void runWithFinally(
      () => confirmRevealHiddenWorkspace(confirm),
      () => {
        confirmationPendingRef.current = false
      }
    ).then((confirmed) => {
      const state = useAppStore.getState()
      if (state.pendingRevealWorktree !== request) {
        return
      }
      if (!confirmed) {
        state.clearPendingRevealWorktreeId(request)
        return
      }
      // Re-check: a workspace switch or filter change while the dialog was open must not adjust stale filters.
      const target = findFilterHiddenActiveTarget(latestArgs.current, request)
      if (target) {
        latestArgs.current.revealWorkspaceFilters(target)
      }
    })
  }, [
    confirm,
    confirmationPendingRef,
    pendingRevealWorktree,
    args.hasFilters,
    args.visibleWorktrees,
    args.visibleFolderWorkspaces,
    args.currentSidebarWorktreeId,
    args.currentSidebarExecutionHostId
  ])
}
