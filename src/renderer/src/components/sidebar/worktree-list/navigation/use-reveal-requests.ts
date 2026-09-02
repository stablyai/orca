import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  SCROLL_TO_CURRENT_WORKSPACE_REVEAL_REQUEST_EVENT,
  type ScrollToCurrentWorkspaceRevealRequestDetail
} from '@/lib/scroll-to-current-workspace-status'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { getKnownSidebarWorktreeById } from './folder-reveal'

// Turns a "show me the current workspace" request into whatever the sidebar must change
// first — grouping mode, active filters — before the viewport can scroll to it.
export function useSidebarRevealRequests(args: {
  groupBy: WorktreeGroupBy
  renderedSidebarRowKeys: ReadonlySet<string>
  renderedWorktreeIdentities: readonly string[]
  currentSidebarWorktreeId: string | null
  currentSidebarExecutionHostId: ExecutionHostId | null
  worktreeMap: Map<string, Worktree>
  worktrees: readonly Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  hasFilters: boolean
  clearFilters: () => void
}): void {
  const {
    groupBy,
    renderedSidebarRowKeys,
    renderedWorktreeIdentities,
    currentSidebarWorktreeId,
    currentSidebarExecutionHostId,
    worktreeMap,
    worktrees,
    folderWorkspaces,
    hasFilters,
    clearFilters
  } = args
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const pendingRevealSidebarRow = useAppStore((s) => s.pendingRevealSidebarRow)
  const revealSidebarRow = useAppStore((s) => s.revealSidebarRow)
  const revealWorktreeInSidebar = useAppStore((s) => s.revealWorktreeInSidebar)

  useEffect(() => {
    if (!pendingRevealSidebarRow) {
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
    if (!renderedSidebarRowKeys.has(rowKey) && hasFilters) {
      clearFilters()
    }
  }, [
    clearFilters,
    groupBy,
    hasFilters,
    pendingRevealSidebarRow,
    renderedSidebarRowKeys,
    setGroupBy
  ])

  const handleRevealCurrentWorkspaceRequest = useCallback(
    (event: Event) => {
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
      const currentIdentity = composeWorktreeHostIdentity(
        currentSidebarExecutionHostId ?? undefined,
        currentSidebarWorktreeId
      )
      if (!renderedWorktreeIdentities.includes(currentIdentity)) {
        // Why: the reveal action must show the current workspace, so relax filters that hide it first.
        clearFilters()
      }
      revealWorktreeInSidebar(currentSidebarWorktreeId, {
        behavior: 'smooth',
        highlight: true,
        beginRename: (detail as { beginRename?: boolean } | undefined)?.beginRename === true,
        executionHostId: currentSidebarExecutionHostId ?? undefined
      })
    },
    [
      clearFilters,
      currentSidebarWorktreeId,
      currentSidebarExecutionHostId,
      folderWorkspaces,
      revealSidebarRow,
      renderedWorktreeIdentities,
      revealWorktreeInSidebar,
      worktreeMap,
      worktrees
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
