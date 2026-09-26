import React, { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  buildLineageVirtualTree,
  getLineageRevealMeasurementIndexes,
  getLineageVirtualChildSpans,
  getLineageVirtualOffsets,
  retainLineageVirtualAncestors
} from '../listing/lineage-virtual-tree'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { useLineageVirtualizer } from '../viewport/use-lineage-virtualizer'
import { renderWorktreeItemRow } from './item-row'
import type { WorktreeVirtualRowContext } from './virtual-row-dispatch'

export type LineageDescendantContext = Pick<
  WorktreeVirtualRowContext,
  | 'scrollRef'
  | 'lineageMeasuredHeights'
  | 'shouldAdjustLineageScroll'
  | 'pendingRevealWorktree'
  | 'pendingRevealSidebarRow'
  | 'worktreeDragState'
  | 'activeWorktreeId'
  | 'item'
>

export function VirtualizedLineageDescendants({
  ctx,
  rows,
  groupStart,
  groupKey
}: {
  ctx: LineageDescendantContext
  rows: readonly WorktreeItemRow[]
  groupStart: number
  groupKey: string
}): React.JSX.Element {
  const tree = useMemo(() => buildLineageVirtualTree(rows.slice(1)), [rows])
  const [interactedRowKey, setInteractedRowKey] = useState<string | null>(null)
  const renamingWorktree = useAppStore((state) => state.renamingWorktreeId)
  const { childrenRef, virtualItems, measurements } = useLineageVirtualizer({
    tree,
    groupStart,
    groupKey,
    shouldAdjustScroll: ctx.shouldAdjustLineageScroll,
    scrollRef: ctx.scrollRef,
    measuredHeights: ctx.lineageMeasuredHeights
  })
  const offsets = useMemo(
    () => getLineageVirtualOffsets(tree, measurements.heights),
    [tree, measurements]
  )
  const retainedIndexes = virtualItems.map((item) => item.index)
  const retainIndex = (index: number, prepareReveal: boolean): void => {
    retainedIndexes.push(index)
    if (prepareReveal) {
      // Measure the landing viewport before reveal so new overscan rows cannot move its title.
      retainedIndexes.push(
        ...getLineageRevealMeasurementIndexes(
          index,
          offsets,
          ctx.scrollRef.current?.clientHeight ?? 0
        )
      )
    }
  }
  const retainRow = (rowKey: string | null | undefined, prepareReveal = false): void => {
    if (!rowKey) {
      return
    }
    const index = tree.indexByRowKey.get(rowKey)
    if (index !== undefined) {
      retainIndex(index, prepareReveal)
    }
  }
  const retainWorktree = (
    id: string | null | undefined,
    hostId?: ExecutionHostId | null,
    prepareReveal = false
  ): void => {
    if (!id) {
      return
    }
    for (const index of tree.indexesByWorktreeId.get(id) ?? []) {
      const { row } = tree.nodes[index]!
      if (!hostId || getWorktreeExecutionHostId(row.worktree, row.repo) === hostId) {
        retainIndex(index, prepareReveal)
      }
    }
  }
  // Keep navigation/rename targets and the last interacted card mounted while a menu or drag owns it.
  retainRow(interactedRowKey)
  retainRow(ctx.pendingRevealSidebarRow?.rowKey, true)
  retainWorktree(ctx.worktreeDragState.draggingWorktreeId)
  retainWorktree(ctx.activeWorktreeId, ctx.item.activeWorkspaceExecutionHostId)
  retainWorktree(
    ctx.pendingRevealWorktree?.worktreeId,
    ctx.pendingRevealWorktree?.executionHostId,
    true
  )
  if (renamingWorktree?.rowKey) {
    retainRow(renamingWorktree.rowKey)
  } else {
    retainWorktree(renamingWorktree?.worktreeId)
  }
  const retained = retainLineageVirtualAncestors(tree, retainedIndexes)

  const renderChildren = (children: readonly number[]): React.ReactNode =>
    getLineageVirtualChildSpans(tree, children, retained, offsets).map((span) => {
      if (span.type === 'spacer') {
        return (
          <div
            key={`spacer:${span.key}`}
            aria-hidden="true"
            data-lineage-virtual-spacer=""
            style={{ height: span.height }}
          />
        )
      }
      const node = tree.nodes[span.index]!
      return (
        <div key={node.row.rowKey} data-lineage-virtual-item={node.row.rowKey}>
          {renderWorktreeItemRow(
            ctx.item,
            node.row,
            true,
            node.children.length > 0 ? (
              <div className="space-y-1" data-lineage-virtual-children="">
                {renderChildren(node.children)}
              </div>
            ) : undefined
          )}
        </div>
      )
    })

  const retainInteractedRow = (event: React.SyntheticEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof Element)) {
      return
    }
    const rowKey =
      event.target.closest<HTMLElement>('[data-worktree-row-key]')?.dataset.worktreeRowKey
    if (rowKey) {
      setInteractedRowKey(rowKey)
    }
  }

  return (
    <div
      ref={childrenRef}
      className="space-y-1"
      data-lineage-virtual-children=""
      onPointerDownCapture={retainInteractedRow}
      onFocusCapture={retainInteractedRow}
      onContextMenuCapture={retainInteractedRow}
    >
      {renderChildren(tree.roots)}
    </div>
  )
}
