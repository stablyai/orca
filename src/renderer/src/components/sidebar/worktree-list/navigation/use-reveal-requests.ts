import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store/index'
import {
  SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
  type ScrollToCurrentWorkspaceRevealRequestDetail
} from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import { hasRenderedSidebarRowKey } from '../listing/rendered-row-keys'
import { getKnownSidebarWorktreeById } from './folder-reveal'
import { readSidebarRevealTarget } from '../../sidebar-reveal-target-state'
import { runWithFinally } from '@/lib/run-with-finally'
import {
  confirmRevealHiddenWorkspace,
  workspacePassesFilters
} from './hidden-workspace-reveal-confirmation'
import { useOpenedWorkspaceRevealPrompt } from './use-opened-workspace-reveal-prompt'

const getAppStoreState = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()

// Adjust grouping and filters before scheduling the requested workspace’s viewport reveal.
export function useSidebarRevealRequests(args: {
  groupBy: WorktreeGroupBy
  sectionRows: readonly HostSectionRow[]
  visibleWorktrees: readonly Worktree[]
  visibleFolderWorkspaces: readonly FolderWorkspace[]
  currentSidebarWorktreeId: string | null
  currentSidebarExecutionHostId: ExecutionHostId | null
  worktreeMap: Map<string, Worktree>
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  hasFilters: boolean
  revealWorkspaceFilters: (worktree: Worktree) => void
}): void {
  const {
    groupBy,
    sectionRows,
    visibleWorktrees,
    visibleFolderWorkspaces,
    currentSidebarWorktreeId,
    currentSidebarExecutionHostId,
    worktreeMap,
    worktrees,
    folderWorkspaces,
    hasFilters,
    revealWorkspaceFilters
  } = args
  const { setGroupBy, revealSidebarRow, revealWorktreeInSidebar } = getAppStoreState()
  const pendingRevealSidebarRow = useAppStore((s) => s.pendingRevealSidebarRow)
  const confirm = useConfirmationDialog()
  const confirmationPending = useRef(false)
  const latestArgs = useRef(args)
  useLayoutEffect(() => {
    latestArgs.current = args
  })
  useOpenedWorkspaceRevealPrompt(args, confirm, confirmationPending)

  useEffect(() => {
    if (
      !pendingRevealSidebarRow ||
      useAppStore.getState().pendingRevealSidebarRow !== pendingRevealSidebarRow
    ) {
      return
    }
    const rowKey = pendingRevealSidebarRow.rowKey
    const isProjectHeaderTarget =
      rowKey.startsWith('project-group:') ||
      rowKey.startsWith('project:') ||
      rowKey.startsWith('repo:')
    if (isProjectHeaderTarget && groupBy !== 'repo') {
      setGroupBy('repo')
      return
    }
    if (hasFilters && !hasRenderedSidebarRowKey(sectionRows, rowKey)) {
      const target = getKnownSidebarWorktreeById(
        rowKey,
        worktreeMap,
        folderWorkspaces,
        worktrees,
        currentSidebarExecutionHostId
      )
      if (target) {
        revealWorkspaceFilters(target)
      }
    }
  }, [
    groupBy,
    hasFilters,
    currentSidebarExecutionHostId,
    folderWorkspaces,
    pendingRevealSidebarRow,
    sectionRows,
    setGroupBy,
    worktreeMap,
    worktrees,
    revealWorkspaceFilters
  ])

  const handleRevealCurrentWorkspaceRequest = useCallback(
    async (event: Event) => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as ScrollToCurrentWorkspaceRevealRequestDetail | undefined)
          : undefined
      if (detail?.target?.type === 'sidebar-row') {
        const sidebarDetail = detail as Extract<
          ScrollToCurrentWorkspaceRevealRequestDetail,
          { target: { type: 'sidebar-row' } }
        >
        revealSidebarRow(detail.target.rowKey, {
          behavior: 'smooth',
          highlight: sidebarDetail.highlight !== false
        })
        return
      }
      if (!currentSidebarWorktreeId) {
        return
      }
      // Bots rows, and what no section lists, are not this list's to reveal: no filter
      // dialog, no filter or group change, no pending reveal that could never land.
      if (readSidebarRevealTarget().section !== 'projects') {
        return
      }
      const activeWorktree = getKnownSidebarWorktreeById(
        currentSidebarWorktreeId,
        worktreeMap,
        folderWorkspaces,
        worktrees,
        currentSidebarExecutionHostId
      )
      if (!activeWorktree || activeWorktree.isArchived) {
        return
      }
      // Collapsed groups hide rows without excluding their workspaces from the filter results.
      if (
        hasFilters &&
        !workspacePassesFilters(activeWorktree, visibleWorktrees, visibleFolderWorkspaces)
      ) {
        if (confirmationPending.current) {
          return
        }
        confirmationPending.current = true
        const confirmed = await runWithFinally(
          () => confirmRevealHiddenWorkspace(confirm),
          () => {
            confirmationPending.current = false
          }
        )
        const latest = latestArgs.current
        // A workspace switch while the dialog is open must not clear filters for a stale target.
        if (
          !confirmed ||
          latest.currentSidebarWorktreeId !== currentSidebarWorktreeId ||
          latest.currentSidebarExecutionHostId !== currentSidebarExecutionHostId
        ) {
          return
        }
        if (
          latest.hasFilters &&
          !workspacePassesFilters(
            activeWorktree,
            latest.visibleWorktrees,
            latest.visibleFolderWorkspaces
          )
        ) {
          revealWorkspaceFilters(activeWorktree)
        }
      }
      revealWorktreeInSidebar(currentSidebarWorktreeId, {
        behavior: 'smooth',
        highlight: true,
        beginRename: (detail as { beginRename?: boolean } | undefined)?.beginRename === true,
        executionHostId: currentSidebarExecutionHostId ?? undefined
      })
    },
    [
      confirm,
      hasFilters,
      currentSidebarWorktreeId,
      currentSidebarExecutionHostId,
      folderWorkspaces,
      revealSidebarRow,
      visibleWorktrees,
      visibleFolderWorkspaces,
      revealWorktreeInSidebar,
      worktreeMap,
      worktrees,
      revealWorkspaceFilters
    ]
  )

  useEffect(() => {
    window.addEventListener(
      SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
      handleRevealCurrentWorkspaceRequest
    )
    return () => {
      window.removeEventListener(
        SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
        handleRevealCurrentWorkspaceRequest
      )
    }
  }, [handleRevealCurrentWorkspaceRequest])
}
