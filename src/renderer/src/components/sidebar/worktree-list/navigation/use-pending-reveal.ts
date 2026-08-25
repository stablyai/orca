import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRenderRowOptionId } from './active-descendant-option'
import {
  findPreferredRenderRowIndexForWorktree,
  findPreferredRenderRowIndexForWorktreeIdentity,
  getRenderRowSidebarKey,
  rowKeyMatchesRenderRow
} from './render-row-lookup'
import { revealMountedSidebarRowElement, revealMountedWorktreeElement } from './mounted-row-reveal'
import { getSidebarRowRevealAncestorKeys } from './reveal-ancestors'
import { sidebarWorkspaceStillExists } from './folder-reveal'
import {
  expandGroupsForWorktreeReveal,
  MAX_REVEAL_RETRIES,
  resolvePendingSidebarReveal,
  type PendingSidebarRevealArgs
} from './pending-reveal-inputs'

// Drives the store's two pending reveal requests (a worktree card, or any sidebar row)
// from "expand the ancestors" through "scroll the mounted element into view".
export function usePendingSidebarReveal(args: PendingSidebarRevealArgs): void {
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const pendingRevealRetryRef = useRef<{ worktreeId: string; count: number } | null>(null)
  const pendingRowRevealRetryRef = useRef<{ rowKey: string; count: number } | null>(null)
  const argsRef = useRef(args)
  useLayoutEffect(() => {
    argsRef.current = args
  })

  const {
    pendingRevealWorktree,
    pendingRevealSidebarRow,
    clearPendingRevealWorktreeId,
    clearPendingRevealSidebarRow,
    renderRows,
    virtualizer,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    flashRevealedRow,
    markRevealScroll,
    pinnedDisplayPolicy
  } = args

  const scheduleRetryTick = useCallback(
    (cancelled: () => boolean) => {
      schedulePendingRevealFrame(() => {
        if (!cancelled()) {
          setPendingRevealRetryTick((tick) => tick + 1)
        }
      })
    },
    [schedulePendingRevealFrame]
  )

  useEffect(() => {
    if (!pendingRevealWorktree) {
      return
    }
    const current = argsRef.current
    if (current.agentSendTargetWorktreeId !== pendingRevealWorktree.worktreeId) {
      expandGroupsForWorktreeReveal(
        current,
        pendingRevealWorktree.worktreeId,
        pendingRevealWorktree.executionHostId
      )
    }

    let cancelled = false
    schedulePendingRevealFrame(() => {
      if (cancelled) {
        return
      }
      const targetWorktreeStillExists = sidebarWorkspaceStillExists(
        pendingRevealWorktree.worktreeId,
        argsRef.current.worktrees,
        argsRef.current.folderWorkspaces,
        pendingRevealWorktree.executionHostId
      )
      const targetIndex = pendingRevealWorktree.executionHostId
        ? findPreferredRenderRowIndexForWorktreeIdentity(
            renderRows,
            {
              id: pendingRevealWorktree.worktreeId,
              hostId: pendingRevealWorktree.executionHostId
            },
            pinnedDisplayPolicy
          )
        : findPreferredRenderRowIndexForWorktree(
            renderRows,
            pendingRevealWorktree.worktreeId,
            pinnedDisplayPolicy
          )
      const outcome = resolvePendingSidebarReveal({ targetIndex, targetWorktreeStillExists })
      if (outcome === 'clear') {
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId()
        return
      }
      if (outcome !== 'scroll-and-clear') {
        return
      }
      const targetRow = renderRows[targetIndex]
      const container = argsRef.current.scrollRef.current
      const revealedOption = container
        ? revealMountedWorktreeElement(
            container,
            pendingRevealWorktree.worktreeId,
            pendingRevealWorktree.behavior,
            getRenderRowOptionId(
              targetRow,
              pendingRevealWorktree.worktreeId,
              pendingRevealWorktree.executionHostId
            ),
            markRevealScroll
          )
        : null
      if (revealedOption) {
        if (pendingRevealWorktree.highlight) {
          const revealedRowKey =
            revealedOption.dataset.worktreeRowKey ?? getRenderRowSidebarKey(targetRow)
          if (revealedRowKey) {
            flashRevealedRow(revealedRowKey)
          }
        }
        if (pendingRevealWorktree.beginRename) {
          setRenamingWorktreeId({
            worktreeId: pendingRevealWorktree.worktreeId,
            rowKey: revealedOption.dataset.worktreeRowKey
          })
        }
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId()
        return
      }

      // Why: virtual indexing can leave the card edge clipped; stage it into the window, then retry the exact DOM reveal.
      virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      const previousRetry = pendingRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.worktreeId === pendingRevealWorktree.worktreeId ? previousRetry.count + 1 : 1
      pendingRevealRetryRef.current = {
        worktreeId: pendingRevealWorktree.worktreeId,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(() => cancelled)
        return
      }
      pendingRevealRetryRef.current = null
      clearPendingRevealWorktreeId()
    })
    return () => {
      cancelled = true
      cancelPendingRevealFrames()
    }
  }, [
    pendingRevealWorktree,
    args.agentSendTargetWorktreeId,
    args.groupBy,
    args.worktrees,
    args.folderWorkspaces,
    args.repoMap,
    args.prCache,
    args.worktreeLineageById,
    args.worktreeMap,
    renderRows,
    virtualizer,
    clearPendingRevealWorktreeId,
    args.toggleGroup,
    args.collapsedGroups,
    args.defaultHostId,
    args.workspaceStatuses,
    args.settings,
    pinnedDisplayPolicy,
    args.projectGrouping,
    args.projectGroups,
    pendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    setRenamingWorktreeId,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scheduleRetryTick
  ])

  useEffect(() => {
    if (!pendingRevealSidebarRow) {
      return
    }
    const current = argsRef.current

    const isProjectHeaderTarget =
      pendingRevealSidebarRow.rowKey.startsWith('project-group:') ||
      pendingRevealSidebarRow.rowKey.startsWith('project:') ||
      pendingRevealSidebarRow.rowKey.startsWith('repo:')
    if (isProjectHeaderTarget && current.groupBy !== 'repo') {
      return
    }

    let toggledAncestor = false
    for (const groupKey of getSidebarRowRevealAncestorKeys({
      rowKey: pendingRevealSidebarRow.rowKey,
      repoMap: current.repoMap,
      projectGroups: current.projectGroups,
      projectGrouping: current.projectGrouping
    })) {
      if (current.collapsedGroups.has(groupKey)) {
        current.toggleGroup(groupKey)
        toggledAncestor = true
      }
    }
    if (toggledAncestor) {
      return
    }

    let cancelled = false
    const retryPendingReveal = (): boolean => {
      const previousRetry = pendingRowRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.rowKey === pendingRevealSidebarRow.rowKey ? previousRetry.count + 1 : 1
      pendingRowRevealRetryRef.current = {
        rowKey: pendingRevealSidebarRow.rowKey,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(() => cancelled)
        return true
      }
      return false
    }
    schedulePendingRevealFrame(() => {
      if (cancelled) {
        return
      }
      const targetIndex = renderRows.findIndex((row) =>
        rowKeyMatchesRenderRow(row, pendingRevealSidebarRow.rowKey)
      )
      if (targetIndex === -1) {
        if (retryPendingReveal()) {
          return
        }
        pendingRowRevealRetryRef.current = null
        clearPendingRevealSidebarRow()
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.sidebarRowMissing',
            'Target no longer exists'
          )
        )
        return
      }

      const container = argsRef.current.scrollRef.current
      const revealedElement = container
        ? revealMountedSidebarRowElement(
            container,
            pendingRevealSidebarRow.rowKey,
            pendingRevealSidebarRow.behavior,
            markRevealScroll
          )
        : null
      if (revealedElement) {
        if (pendingRevealSidebarRow.highlight) {
          flashRevealedRow(pendingRevealSidebarRow.rowKey)
        }
        pendingRowRevealRetryRef.current = null
        clearPendingRevealSidebarRow()
        return
      }

      virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      if (retryPendingReveal()) {
        return
      }
      pendingRowRevealRetryRef.current = null
      clearPendingRevealSidebarRow()
    })

    return () => {
      cancelled = true
      cancelPendingRevealFrames()
    }
  }, [
    pendingRevealSidebarRow,
    args.repoMap,
    args.projectGroups,
    args.projectGrouping,
    args.collapsedGroups,
    args.groupBy,
    args.toggleGroup,
    renderRows,
    virtualizer,
    pendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    clearPendingRevealSidebarRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scheduleRetryTick
  ])
}
