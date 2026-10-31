import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getWorktreeOptionId } from '../rows/option-dom'
import { getRenderRowOptionId } from './active-descendant-option'
import { getRenderRowSidebarKey, rowKeyMatchesRenderRow } from './render-row-lookup'
import { revealMountedSidebarRowElement, revealMountedWorktreeElement } from './mounted-row-reveal'
import { getSidebarRowRevealAncestorKeys } from './reveal-ancestors'
import {
  expandGroupsForWorktreeReveal,
  MAX_REVEAL_RETRIES,
  resolvePendingWorktreeRevealTarget,
  type PendingSidebarRevealArgs
} from './pending-reveal-inputs'

export function usePendingSidebarReveal(args: PendingSidebarRevealArgs): void {
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const [pendingRevealRetryTick, setPendingRevealRetryTick] = useState(0)
  const pendingRevealRetryRef = useRef<{
    request: NonNullable<PendingSidebarRevealArgs['pendingRevealWorktree']>
    count: number
  } | null>(null)
  const pendingRowRevealRetryRef = useRef<{
    request: NonNullable<PendingSidebarRevealArgs['pendingRevealSidebarRow']>
    count: number
  } | null>(null)
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
    if (
      !pendingRevealWorktree ||
      useAppStore.getState().pendingRevealWorktree !== pendingRevealWorktree
    ) {
      return
    }
    const current = argsRef.current
    const isCurrent = () => useAppStore.getState().pendingRevealWorktree === pendingRevealWorktree
    if (
      !pendingRevealWorktree.rowKey &&
      current.agentSendTargetWorktreeId !== pendingRevealWorktree.worktreeId
    ) {
      expandGroupsForWorktreeReveal(
        current,
        pendingRevealWorktree.worktreeId,
        pendingRevealWorktree.executionHostId
      )
    }

    let cancelled = false
    schedulePendingRevealFrame(() => {
      if (cancelled || !isCurrent()) {
        return
      }
      const currentRows = argsRef.current.renderRows
      const rowKey = pendingRevealWorktree.rowKey
      const { targetIndex, outcome } = resolvePendingWorktreeRevealTarget(
        argsRef.current,
        pendingRevealWorktree
      )
      if (outcome === 'clear') {
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId(pendingRevealWorktree)
        return
      }
      if (outcome !== 'scroll-and-clear') {
        return
      }
      const targetRow = currentRows[targetIndex]
      const container = argsRef.current.scrollRef.current
      const revealedOption = container
        ? revealMountedWorktreeElement(
            container,
            pendingRevealWorktree.worktreeId,
            pendingRevealWorktree.behavior,
            rowKey
              ? getWorktreeOptionId(rowKey)
              : getRenderRowOptionId(
                  targetRow,
                  pendingRevealWorktree.worktreeId,
                  pendingRevealWorktree.executionHostId
                ),
            markRevealScroll
          )
        : null
      if (revealedOption) {
        if (pendingRevealWorktree.highlight && isCurrent()) {
          const revealedRowKey =
            revealedOption.dataset.worktreeRowKey ?? getRenderRowSidebarKey(targetRow)
          if (revealedRowKey) {
            flashRevealedRow(revealedRowKey)
          }
        }
        if (pendingRevealWorktree.beginRename && isCurrent()) {
          setRenamingWorktreeId({
            worktreeId: pendingRevealWorktree.worktreeId,
            rowKey: revealedOption.dataset.worktreeRowKey
          })
        }
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId(pendingRevealWorktree)
        return
      }

      // Why: virtual indexing can leave the card edge clipped; stage it into the window, then retry the exact DOM reveal.
      virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      if (!isCurrent()) {
        return
      }
      const previousRetry = pendingRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.request === pendingRevealWorktree ? previousRetry.count + 1 : 1
      pendingRevealRetryRef.current = {
        request: pendingRevealWorktree,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(() => cancelled || !isCurrent())
        return
      }
      pendingRevealRetryRef.current = null
      clearPendingRevealWorktreeId(pendingRevealWorktree)
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
    args.occurrencePlan,
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
    if (
      !pendingRevealSidebarRow ||
      useAppStore.getState().pendingRevealSidebarRow !== pendingRevealSidebarRow
    ) {
      return
    }
    const current = argsRef.current
    const isCurrent = () =>
      useAppStore.getState().pendingRevealSidebarRow === pendingRevealSidebarRow

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
        previousRetry?.request === pendingRevealSidebarRow ? previousRetry.count + 1 : 1
      pendingRowRevealRetryRef.current = {
        request: pendingRevealSidebarRow,
        count: nextRetryCount
      }
      if (nextRetryCount <= MAX_REVEAL_RETRIES) {
        scheduleRetryTick(() => cancelled || !isCurrent())
        return true
      }
      return false
    }
    schedulePendingRevealFrame(() => {
      if (cancelled || !isCurrent()) {
        return
      }
      const targetIndex = argsRef.current.renderRows.findIndex((row) =>
        rowKeyMatchesRenderRow(row, pendingRevealSidebarRow.rowKey)
      )
      if (targetIndex === -1) {
        if (retryPendingReveal()) {
          return
        }
        pendingRowRevealRetryRef.current = null
        clearPendingRevealSidebarRow(pendingRevealSidebarRow)
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
        if (pendingRevealSidebarRow.highlight && isCurrent()) {
          flashRevealedRow(pendingRevealSidebarRow.rowKey)
        }
        pendingRowRevealRetryRef.current = null
        clearPendingRevealSidebarRow(pendingRevealSidebarRow)
        return
      }

      virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
      if (!isCurrent()) {
        return
      }
      if (retryPendingReveal()) {
        return
      }
      pendingRowRevealRetryRef.current = null
      clearPendingRevealSidebarRow(pendingRevealSidebarRow)
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
