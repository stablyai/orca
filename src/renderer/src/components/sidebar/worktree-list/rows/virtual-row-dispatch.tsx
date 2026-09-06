import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import { getWorkspaceStatus } from '../../workspace-status'
import type { WorktreeGroupBy } from '../grouping/row-types'
import {
  getVirtualRowTransform,
  getWorktreeVirtualRowTransform,
  shouldUseHeaderTopSpacing
} from '../viewport/virtual-rows'
import type { RenderRow } from '../listing/render-row'
import type { ImportedWorktreeCardActionState } from '../../imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from '../../new-external-worktrees-inbox-actions'
import type { useHostHeaderDrag } from '../../host-header-drag'
import { HostSectionHeader } from './HostSectionHeader'
import { renderFolderWorkspaceVirtualRow, type FolderWorkspaceRowContext } from './folder-row'
import {
  renderImportedWorktreesVirtualRow,
  renderNewExternalWorktreesInboxVirtualRow,
  renderPendingCreationVirtualRow
} from './notice-rows'
import {
  renderWorktreeItemRow,
  renderWorktreeLineageDescendants,
  type WorktreeItemRowContext
} from './item-row'
import { renderWorktreeSectionHeaderRow, type SectionHeaderRowContext } from './SectionHeader'
import {
  renderCollectionSectionHeaderRow,
  type CollectionSectionHeaderContext
} from './CollectionSectionHeader'
import type { WorktreeRowDragState } from '../drag/row-state'

export type WorktreeVirtualRowContext = {
  renderRows: RenderRow[]
  firstHeaderIndex: number
  activeStickyHeaderIndexRef: React.MutableRefObject<number | null>
  activeStickyHostIndexRef: React.MutableRefObject<number | null>
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  groupBy: WorktreeGroupBy
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  activeWorktreeId: string | null
  worktreeDragState: WorktreeRowDragState
  orderedHostIds: readonly string[]
  hostDrag: ReturnType<typeof useHostHeaderDrag>
  toggleGroupWithScrollAnchor: (groupKey: string) => void
  header: SectionHeaderRowContext
  collectionHeader: CollectionSectionHeaderContext
  item: WorktreeItemRowContext
  folderWorkspace: FolderWorkspaceRowContext
  importedWorktreeCardActionState: ReadonlyMap<string, ImportedWorktreeCardActionState>
  newExternalWorktreeInboxActionState: ReadonlyMap<string, NewExternalWorktreesInboxActionState>
  onShowImportedWorktrees: (projectId: string) => void
  onKeepImportedWorktreesHidden: (projectId: string) => void
  onOpenWorktreeVisibility: (
    repo: Parameters<SectionHeaderRowContext['projectActions']['onOpenWorktreeVisibility']>[0]
  ) => void
  onOpenSuppressExternalWorktreeInbox: (projectId: string) => void
  onWorkspaceStatusDragOver: (event: React.DragEvent, status: WorkspaceStatus) => void
  onWorkspaceStatusDragLeave: (event: React.DragEvent) => void
  onWorkspaceStatusDrop: (event: React.DragEvent, status: WorkspaceStatus) => void
}

function renderHostHeaderVirtualRow(
  ctx: WorktreeVirtualRowContext,
  row: Extract<RenderRow, { type: 'host-header' }>,
  vItem: VirtualItem
): React.JSX.Element {
  // Why: the host card is the outer tier; it pins above group headers (z-30 vs z-20) and stays put as they hand off.
  const isActiveStickyHost = ctx.activeStickyHostIndexRef.current === vItem.index
  const hasHeaderTopSpacing = shouldUseHeaderTopSpacing({
    rows: ctx.renderRows,
    index: vItem.index,
    firstHeaderIndex: ctx.firstHeaderIndex
  })
  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-sticky-header=""
      data-worktree-sticky-header-active={isActiveStickyHost ? '' : undefined}
      data-index={vItem.index}
      ref={ctx.measureVirtualRowElement}
      className={cn(
        'left-0 right-0',
        hasHeaderTopSpacing && !isActiveStickyHost && 'pt-1',
        isActiveStickyHost ? 'sticky -top-px z-30 bg-worktree-sidebar' : 'absolute top-0'
      )}
      style={isActiveStickyHost ? undefined : { transform: getVirtualRowTransform(vItem.start) }}
    >
      <HostSectionHeader
        row={row}
        onToggle={() => ctx.toggleGroupWithScrollAnchor(row.key)}
        onDragPointerDown={
          ctx.orderedHostIds.length > 1
            ? (e) => ctx.hostDrag.onHandlePointerDown(e, row.hostId)
            : undefined
        }
        dragging={ctx.hostDrag.state.draggingHostId === row.hostId}
      />
    </div>
  )
}

function renderLineageGroupVirtualRow(
  ctx: WorktreeVirtualRowContext,
  row: Extract<RenderRow, { type: 'lineage-group' }>,
  vItem: VirtualItem
): React.JSX.Element {
  const [parent, ...children] = row.rows
  const childIsActive = children.some((child) => child.worktree.id === ctx.activeWorktreeId)
  const parentPreviewOffset = parent
    ? (ctx.worktreeDragState.previewOffsetsByWorktreeId.get(parent.worktree.id) ?? 0)
    : 0
  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={ctx.measureVirtualRowElement}
      className={cn(
        'absolute left-0 right-0 top-0',
        ctx.worktreeDragState.draggingWorktreeId !== null &&
          'transition-transform duration-150 ease-out will-change-transform'
      )}
      style={{ transform: getWorktreeVirtualRowTransform(vItem.start, parentPreviewOffset) }}
    >
      <div className="overflow-visible">
        {parent
          ? renderWorktreeItemRow(
              ctx.item,
              parent,
              false,
              renderWorktreeLineageDescendants(ctx.item, parent, children),
              childIsActive
            )
          : null}
      </div>
    </div>
  )
}

// One virtual slot -> one row renderer. Every branch owns its own absolute/sticky frame
// because sticky headers and lineage groups position differently from plain cards.
export function renderWorktreeVirtualRow(
  ctx: WorktreeVirtualRowContext,
  row: RenderRow,
  vItem: VirtualItem
): React.JSX.Element | null {
  if (row.type === 'host-header') {
    return renderHostHeaderVirtualRow(ctx, row, vItem)
  }

  if (row.type === 'header' && row.collection) {
    return renderCollectionSectionHeaderRow({
      ctx: ctx.collectionHeader,
      row,
      vItem,
      hasHeaderTopSpacing: shouldUseHeaderTopSpacing({
        rows: ctx.renderRows,
        index: vItem.index,
        firstHeaderIndex: ctx.firstHeaderIndex
      }),
      measureVirtualRowElement: ctx.measureVirtualRowElement
    })
  }

  if (row.type === 'header') {
    return renderWorktreeSectionHeaderRow({
      ctx: ctx.header,
      row,
      vItem,
      isActiveStickyHeader: ctx.activeStickyHeaderIndexRef.current === vItem.index,
      hasStickyHost: ctx.activeStickyHostIndexRef.current !== null,
      hasHeaderTopSpacing: shouldUseHeaderTopSpacing({
        rows: ctx.renderRows,
        index: vItem.index,
        firstHeaderIndex: ctx.firstHeaderIndex
      }),
      measureVirtualRowElement: ctx.measureVirtualRowElement
    })
  }

  if (row.type === 'lineage-group') {
    return renderLineageGroupVirtualRow(ctx, row, vItem)
  }

  if (row.type === 'imported-worktrees-card') {
    return renderImportedWorktreesVirtualRow({
      row,
      vItem,
      measureVirtualRowElement: ctx.measureVirtualRowElement,
      actionState: ctx.importedWorktreeCardActionState.get(row.repo.id),
      onShow: ctx.onShowImportedWorktrees,
      onKeepHidden: ctx.onKeepImportedWorktreesHidden
    })
  }

  if (row.type === 'new-external-worktrees-inbox') {
    return renderNewExternalWorktreesInboxVirtualRow({
      row,
      vItem,
      measureVirtualRowElement: ctx.measureVirtualRowElement,
      actionState: ctx.newExternalWorktreeInboxActionState.get(row.repo.id),
      onReview: ctx.onOpenWorktreeVisibility,
      onSuppress: ctx.onOpenSuppressExternalWorktreeInbox
    })
  }

  if (row.type === 'pending-creation') {
    return renderPendingCreationVirtualRow({
      row,
      vItem,
      measureVirtualRowElement: ctx.measureVirtualRowElement
    })
  }

  if (row.type === 'folder-workspace') {
    return renderFolderWorkspaceVirtualRow({
      ctx: ctx.folderWorkspace,
      row,
      vItem,
      measureVirtualRowElement: ctx.measureVirtualRowElement
    })
  }

  const itemWorkspaceStatus =
    ctx.groupBy === 'workspace-status'
      ? getWorkspaceStatus(row.worktree, ctx.workspaceStatuses)
      : null
  const itemPreviewOffset =
    ctx.worktreeDragState.previewOffsetsByWorktreeId.get(row.worktree.id) ?? 0

  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={ctx.measureVirtualRowElement}
      data-workspace-status-drop-target={itemWorkspaceStatus ? '' : undefined}
      data-workspace-status={itemWorkspaceStatus ?? undefined}
      className={cn(
        'absolute left-0 right-0 top-0',
        ctx.worktreeDragState.draggingWorktreeId !== null &&
          'transition-transform duration-150 ease-out will-change-transform'
      )}
      style={{ transform: getWorktreeVirtualRowTransform(vItem.start, itemPreviewOffset) }}
      onDragOver={
        itemWorkspaceStatus
          ? (event) => ctx.onWorkspaceStatusDragOver(event, itemWorkspaceStatus)
          : undefined
      }
      onDragLeave={itemWorkspaceStatus ? ctx.onWorkspaceStatusDragLeave : undefined}
      onDrop={
        itemWorkspaceStatus
          ? (event) => ctx.onWorkspaceStatusDrop(event, itemWorkspaceStatus)
          : undefined
      }
    >
      {renderWorktreeItemRow(ctx.item, row, false)}
    </div>
  )
}
