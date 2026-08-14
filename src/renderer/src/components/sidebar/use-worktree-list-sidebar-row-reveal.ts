import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import type { PendingSidebarRowReveal } from '@/store/slices/ui'
import type { ProjectGroup, Repo } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import type { ProjectGroupingModel, WorktreeGroupBy } from './worktree-list-groups'
import type { RenderRow } from './worktree-list-virtual-rows'
import { getSidebarRowRevealAncestorKeys } from './worktree-list-row-ancestry'
import { rowKeyMatchesRenderRow } from './worktree-list-render-row-model'
import { revealMountedSidebarRowElement } from './worktree-list-dom-activation'

type RevealVirtualizer = {
  scrollToIndex: (index: number, options: { align: 'auto'; behavior: 'auto' }) => void
}

type Args = {
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  projectGrouping?: ProjectGroupingModel
  collapsedGroups: Set<string>
  groupBy: WorktreeGroupBy
  toggleGroup: (key: string) => void
  renderRows: readonly RenderRow[]
  virtualizer: RevealVirtualizer
  pendingRevealRetryTick: number
  setPendingRevealRetryTick: Dispatch<SetStateAction<number>>
  flashRevealedRow: (rowKey: string) => void
  markRevealScroll: (targetTop: number) => void
  clearPendingRevealSidebarRow: () => void
  schedulePendingRevealFrame: (callback: FrameRequestCallback) => void
  cancelPendingRevealFrames: () => void
  scrollRef: MutableRefObject<HTMLDivElement | null>
  pendingRowRevealRetryRef: MutableRefObject<{ rowKey: string; count: number } | null>
}

export function useWorktreeListSidebarRowReveal(args: Args): void {
  const {
    pendingRevealSidebarRow,
    repoMap,
    projectGroups,
    projectGrouping,
    collapsedGroups,
    groupBy,
    toggleGroup,
    renderRows,
    virtualizer,
    pendingRevealRetryTick,
    setPendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    clearPendingRevealSidebarRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    pendingRowRevealRetryRef
  } = args

  useEffect(() => {
    if (!pendingRevealSidebarRow) {
      return
    }
    const isProjectHeaderTarget =
      pendingRevealSidebarRow.rowKey.startsWith('project-group:') ||
      pendingRevealSidebarRow.rowKey.startsWith('project:') ||
      pendingRevealSidebarRow.rowKey.startsWith('repo:')
    if (isProjectHeaderTarget && groupBy !== 'repo') {
      return
    }

    let toggledAncestor = false
    for (const groupKey of getSidebarRowRevealAncestorKeys({
      rowKey: pendingRevealSidebarRow.rowKey,
      repoMap,
      projectGroups,
      projectGrouping
    })) {
      if (collapsedGroups.has(groupKey)) {
        toggleGroup(groupKey)
        toggledAncestor = true
      }
    }
    if (toggledAncestor) {
      return
    }

    let cancelled = false
    const retryPendingReveal = () => {
      const previousRetry = pendingRowRevealRetryRef.current
      const nextRetryCount =
        previousRetry?.rowKey === pendingRevealSidebarRow.rowKey ? previousRetry.count + 1 : 1
      pendingRowRevealRetryRef.current = {
        rowKey: pendingRevealSidebarRow.rowKey,
        count: nextRetryCount
      }
      if (nextRetryCount <= 8) {
        schedulePendingRevealFrame(() => {
          if (!cancelled) {
            setPendingRevealRetryTick((tick) => tick + 1)
          }
        })
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

      const retryExactRevealOnNextFrame = () => {
        if (retryPendingReveal()) {
          return
        }
        pendingRowRevealRetryRef.current = null
        clearPendingRevealSidebarRow()
      }
      const revealedElement = scrollRef.current
        ? revealMountedSidebarRowElement(
            scrollRef.current,
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
      retryExactRevealOnNextFrame()
    })

    return () => {
      cancelled = true
      cancelPendingRevealFrames()
    }
  }, [
    pendingRevealSidebarRow,
    repoMap,
    projectGroups,
    projectGrouping,
    collapsedGroups,
    groupBy,
    toggleGroup,
    renderRows,
    virtualizer,
    pendingRevealRetryTick,
    pendingRowRevealRetryRef,
    flashRevealedRow,
    markRevealScroll,
    clearPendingRevealSidebarRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    setPendingRevealRetryTick
  ])
}
