import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AppState } from '@/store/types'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  Worktree,
  WorktreeLineage,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { RenderRow } from './worktree-list-virtual-rows'
import type {
  PinnedWorktreeDisplayPolicy,
  ProjectGroupingModel,
  WorktreeGroupBy
} from './worktree-list-groups'
import { getGroupKeysForWorktree, getLineageGroupKey } from './worktree-list-groups'
import { getWorktreeLineageAncestors } from './worktree-lineage-projection'
import {
  getFolderWorkspaceRevealGroupKeys,
  sidebarWorkspaceStillExists
} from './worktree-list-folder-reveal'
import {
  findPreferredRenderRowIndexForWorktree,
  getPinnedWorktreeRevealCollapsedGroupKeys,
  getRenderRowOptionId,
  getRenderRowSidebarKey
} from './worktree-list-render-row-model'
import { revealMountedWorktreeElement } from './worktree-list-dom-activation'
import { resolvePendingSidebarReveal } from './worktree-list-behavior'

type RevealVirtualizer = {
  scrollToIndex: (index: number, options: { align: 'auto'; behavior: 'auto' }) => void
}

type Args = {
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  agentSendTargetWorktreeId: string | null
  groupBy: WorktreeGroupBy
  worktrees: Worktree[]
  folderWorkspaces: readonly FolderWorkspace[]
  repoMap: Map<string, Repo>
  prCache: AppState['prCache'] | null
  worktreeLineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  renderRows: readonly RenderRow[]
  virtualizer: RevealVirtualizer
  clearPendingRevealWorktreeId: () => void
  toggleGroup: (key: string) => void
  collapsedGroups: Set<string>
  defaultHostId: ExecutionHostId
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings: AppState['settings']
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  projectGrouping?: ProjectGroupingModel
  projectGroups: readonly ProjectGroup[]
  pendingRevealRetryTick: number
  setPendingRevealRetryTick: Dispatch<SetStateAction<number>>
  flashRevealedRow: (rowKey: string) => void
  markRevealScroll: (targetTop: number) => void
  setRenamingWorktreeId: AppState['setRenamingWorktreeId']
  schedulePendingRevealFrame: (callback: FrameRequestCallback) => void
  cancelPendingRevealFrames: () => void
  scrollRef: MutableRefObject<HTMLDivElement | null>
  pendingRevealRetryRef: MutableRefObject<{ worktreeId: string; count: number } | null>
}

export function useWorktreeListWorkspaceReveal(args: Args): void {
  const {
    pendingRevealWorktree,
    agentSendTargetWorktreeId,
    groupBy,
    worktrees,
    folderWorkspaces,
    repoMap,
    prCache,
    worktreeLineageById,
    worktreeMap,
    renderRows,
    virtualizer,
    clearPendingRevealWorktreeId,
    toggleGroup,
    collapsedGroups,
    defaultHostId,
    workspaceStatuses,
    settings,
    pinnedDisplayPolicy,
    projectGrouping,
    projectGroups,
    pendingRevealRetryTick,
    setPendingRevealRetryTick,
    flashRevealedRow,
    markRevealScroll,
    setRenamingWorktreeId,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    pendingRevealRetryRef
  } = args

  useEffect(() => {
    if (!pendingRevealWorktree) {
      return
    }
    if (agentSendTargetWorktreeId !== pendingRevealWorktree.worktreeId) {
      const folderGroupKeys = getFolderWorkspaceRevealGroupKeys(
        pendingRevealWorktree.worktreeId,
        folderWorkspaces,
        projectGroups
      )
      if (folderGroupKeys.length > 0) {
        for (const groupKey of folderGroupKeys) {
          if (collapsedGroups.has(groupKey)) {
            toggleGroup(groupKey)
          }
        }
      } else {
        const targetWorktree = worktrees.find(
          (worktree) => worktree.id === pendingRevealWorktree.worktreeId
        )
        const targetRepo = targetWorktree ? repoMap.get(targetWorktree.repoId) : undefined
        if (targetWorktree) {
          const hostId = getWorktreeExecutionHostId(targetWorktree, targetRepo, defaultHostId)
          const hostGroupKey = `host:${hostId}`
          if (collapsedGroups.has(hostGroupKey)) {
            toggleGroup(hostGroupKey)
          }
          for (const parent of getWorktreeLineageAncestors(
            targetWorktree,
            worktreeLineageById,
            worktreeMap
          )) {
            const lineageGroupKey = getLineageGroupKey(parent.id)
            if (collapsedGroups.has(lineageGroupKey)) {
              toggleGroup(lineageGroupKey)
            }
          }
          const groupKeys =
            targetWorktree.isPinned && pinnedDisplayPolicy === 'single-location'
              ? getPinnedWorktreeRevealCollapsedGroupKeys({
                  worktree: targetWorktree,
                  collapsedGroups
                })
              : getGroupKeysForWorktree(
                  groupBy,
                  targetWorktree,
                  repoMap,
                  prCache,
                  workspaceStatuses,
                  settings,
                  projectGroups,
                  projectGrouping
                )
          for (const groupKey of groupKeys) {
            if (collapsedGroups.has(groupKey)) {
              toggleGroup(groupKey)
            }
          }
        }
      }
    }

    let cancelled = false
    schedulePendingRevealFrame(() => {
      if (cancelled) {
        return
      }
      const targetWorktreeStillExists = sidebarWorkspaceStillExists(
        pendingRevealWorktree.worktreeId,
        worktrees,
        folderWorkspaces
      )
      const targetIndex = findPreferredRenderRowIndexForWorktree(
        renderRows,
        pendingRevealWorktree.worktreeId,
        pinnedDisplayPolicy
      )
      const outcome = resolvePendingSidebarReveal({ targetIndex, targetWorktreeStillExists })
      if (outcome === 'scroll-and-clear') {
        const targetRow = renderRows[targetIndex]
        const retryExactRevealOnNextFrame = () => {
          const previousRetry = pendingRevealRetryRef.current
          const nextRetryCount =
            previousRetry?.worktreeId === pendingRevealWorktree.worktreeId
              ? previousRetry.count + 1
              : 1
          pendingRevealRetryRef.current = {
            worktreeId: pendingRevealWorktree.worktreeId,
            count: nextRetryCount
          }
          if (nextRetryCount <= 8) {
            schedulePendingRevealFrame(() => {
              if (!cancelled) {
                setPendingRevealRetryTick((tick) => tick + 1)
              }
            })
          } else {
            pendingRevealRetryRef.current = null
            clearPendingRevealWorktreeId()
          }
        }
        const revealedOption = scrollRef.current
          ? revealMountedWorktreeElement(
              scrollRef.current,
              pendingRevealWorktree.worktreeId,
              pendingRevealWorktree.behavior,
              getRenderRowOptionId(targetRow, pendingRevealWorktree.worktreeId),
              markRevealScroll
            )
          : null
        if (revealedOption) {
          if (pendingRevealWorktree.highlight) {
            const rowKey =
              revealedOption.dataset.worktreeRowKey ?? getRenderRowSidebarKey(targetRow)
            if (rowKey) {
              flashRevealedRow(rowKey)
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
        // Why: for lineage groups the virtual row is only a staging target; jump into the window, then retry the exact reveal.
        virtualizer.scrollToIndex(targetIndex, { align: 'auto', behavior: 'auto' })
        retryExactRevealOnNextFrame()
        return
      }
      if (outcome === 'clear') {
        pendingRevealRetryRef.current = null
        clearPendingRevealWorktreeId()
      }
    })
    return () => {
      cancelled = true
      cancelPendingRevealFrames()
    }
  }, [
    pendingRevealWorktree,
    agentSendTargetWorktreeId,
    groupBy,
    worktrees,
    folderWorkspaces,
    repoMap,
    prCache,
    worktreeLineageById,
    worktreeMap,
    renderRows,
    virtualizer,
    clearPendingRevealWorktreeId,
    toggleGroup,
    collapsedGroups,
    defaultHostId,
    workspaceStatuses,
    settings,
    pinnedDisplayPolicy,
    projectGrouping,
    projectGroups,
    pendingRevealRetryTick,
    pendingRevealRetryRef,
    flashRevealedRow,
    markRevealScroll,
    setRenamingWorktreeId,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    scrollRef,
    setPendingRevealRetryTick
  ])
}
