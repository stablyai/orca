import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getRenderRowOptionId } from './active-descendant-option'
import { getRenderRowSidebarKey, rowKeyMatchesRenderRow } from './render-row-lookup'
import { revealMountedSidebarRowElement, revealMountedWorktreeElement } from './mounted-row-reveal'
import { expandSidebarRowRevealAncestors } from './expand-sidebar-row-reveal-ancestors'
import { sidebarWorkspaceStillExists } from './folder-reveal'
import { useMountedSidebarRevealOwner } from './use-mounted-reveal-owner'
import {
  expandGroupsForWorktreeReveal,
  findPendingWorktreeRevealIndex,
  MAX_REVEAL_RETRIES,
  resolvePendingSidebarReveal,
  type PendingSidebarRevealArgs
} from './pending-reveal-inputs'

// Drives the store's two pending reveal requests (a worktree card, or any sidebar row)
// from "expand the ancestors" through "scroll the mounted element into view".
export function usePendingSidebarReveal(args: PendingSidebarRevealArgs): () => void {
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const pendingRevealRetryRef = useRef<{
    request: PendingSidebarRevealArgs['pendingRevealWorktree']
    count: number
  } | null>(null)
  const pendingRowRevealRetryRef = useRef<{
    request: PendingSidebarRevealArgs['pendingRevealSidebarRow']
    count: number
  } | null>(null)
  const argsRef = useRef(args)
  useLayoutEffect(() => {
    argsRef.current = args
  })

  const mounted = useMountedSidebarRevealOwner(argsRef)

  const {
    pendingRevealWorktree,
    pendingRevealSidebarRow,
    clearPendingRevealWorktreeId,
    clearPendingRevealSidebarRow,
    renderRows,
    virtualizer,
    schedulePendingRevealFrame,
    flashRevealedRow,
    markRevealScroll,
    pinnedDisplayPolicy
  } = args

  const scheduleRetryTick = useCallback(
    (cancelled: () => boolean) => {
      argsRef.current.schedulePendingRevealFrame(() => {
        if (!cancelled()) {
          setPendingRevealRetryTick((tick) => tick + 1)
        }
      })
    },
    [schedulePendingRevealFrame]
  )

  useEffect(() => {
    if (!pendingRevealWorktree || mounted.has(pendingRevealWorktree)) {
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
    const isCancelled = () =>
      cancelled || useAppStore.getState().pendingRevealWorktree !== pendingRevealWorktree
    schedulePendingRevealFrame(() => {
      if (isCancelled()) {
        return
      }
      const current = argsRef.current
      const targetWorktreeStillExists = sidebarWorkspaceStillExists(
        pendingRevealWorktree.worktreeId,
        current.worktrees,
        current.folderWorkspaces,
        pendingRevealWorktree.executionHostId,
        { projectGroups: current.projectGroups, defaultHostId: current.defaultHostId }
      )
      const targetIndex = findPendingWorktreeRevealIndex(
        current.renderRows,
        pendingRevealWorktree,
        current.pinnedDisplayPolicy
      )
      const outcome = resolvePendingSidebarReveal({ targetIndex, targetWorktreeStillExists })
      if (outcome === 'clear') {
        pendingRevealRetryRef.current = null
        argsRef.current.clearPendingRevealWorktreeId()
        return
      }
      if (outcome !== 'scroll-and-clear') {
        return
      }
      const targetRow = current.renderRows[targetIndex]
      const container = current.scrollRef.current
      if (
        container &&
        mounted.start(
          pendingRevealWorktree,
          container,
          () =>
            revealMountedWorktreeElement(
              container,
              pendingRevealWorktree.worktreeId,
              pendingRevealWorktree.behavior,
              getRenderRowOptionId(
                targetRow,
                pendingRevealWorktree.worktreeId,
                pendingRevealWorktree.executionHostId
              ),
              (top) => argsRef.current.markRevealScroll(top)
            ),
          getRenderRowSidebarKey(targetRow),
          () => {
            pendingRevealRetryRef.current = null
          }
        )
      ) {
        return
      }

      // Why: virtual indexing can leave the card edge clipped; stage it into the window, then retry the exact DOM reveal.
      current.virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      const previousRetry = pendingRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.request === pendingRevealWorktree ? previousRetry.count + 1 : 1
      pendingRevealRetryRef.current = {
        request: pendingRevealWorktree,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(isCancelled)
        return
      }
      pendingRevealRetryRef.current = null
      argsRef.current.clearPendingRevealWorktreeId()
    })
    return () => {
      cancelled = true
    }
  }, [
    mounted,
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
    args.scrollElement,
    pendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    schedulePendingRevealFrame,
    scheduleRetryTick
  ])

  useEffect(() => {
    if (!pendingRevealSidebarRow || mounted.has(pendingRevealSidebarRow)) {
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

    if (expandSidebarRowRevealAncestors(current, pendingRevealSidebarRow.rowKey)) {
      return
    }

    let cancelled = false
    const isCancelled = () =>
      cancelled || useAppStore.getState().pendingRevealSidebarRow !== pendingRevealSidebarRow
    const retryPendingReveal = (): boolean => {
      const previousRetry = pendingRowRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.request === pendingRevealSidebarRow ? previousRetry.count + 1 : 1
      pendingRowRevealRetryRef.current = {
        request: pendingRevealSidebarRow,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(isCancelled)
        return true
      }
      return false
    }
    schedulePendingRevealFrame(() => {
      if (isCancelled()) {
        return
      }
      const current = argsRef.current
      const targetIndex = current.renderRows.findIndex((row) =>
        rowKeyMatchesRenderRow(row, pendingRevealSidebarRow.rowKey)
      )
      if (targetIndex === -1) {
        if (retryPendingReveal()) {
          return
        }
        pendingRowRevealRetryRef.current = null
        argsRef.current.clearPendingRevealSidebarRow()
        toast.error(
          translate(
            'auto.components.sidebar.WorktreeList.sidebarRowMissing',
            'Target no longer exists'
          )
        )
        return
      }

      const container = current.scrollRef.current
      if (
        container &&
        mounted.start(
          pendingRevealSidebarRow,
          container,
          () =>
            revealMountedSidebarRowElement(
              container,
              pendingRevealSidebarRow.rowKey,
              pendingRevealSidebarRow.behavior,
              (top) => argsRef.current.markRevealScroll(top)
            ),
          pendingRevealSidebarRow.rowKey,
          () => {
            pendingRowRevealRetryRef.current = null
          }
        )
      ) {
        return
      }

      current.virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      if (retryPendingReveal()) {
        return
      }
      pendingRowRevealRetryRef.current = null
      argsRef.current.clearPendingRevealSidebarRow()
    })

    return () => {
      cancelled = true
    }
  }, [
    mounted,
    pendingRevealSidebarRow,
    args.repoMap,
    args.projectGroups,
    args.projectGrouping,
    args.collapsedGroups,
    args.groupBy,
    args.toggleGroup,
    renderRows,
    virtualizer,
    args.scrollElement,
    pendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    clearPendingRevealSidebarRow,
    schedulePendingRevealFrame,
    scheduleRetryTick
  ])
  return mounted.cancel
}
