import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/class-names'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import '../../workspace-status/presentation/workspace-status'
import { getWorkspaceStatus } from '../../../../../../shared/workspace-statuses'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/active-workspace'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getVirtualRowTransform,
  getWorktreeVirtualRowTransform,
  shouldUseHeaderTopSpacing
} from '../viewport/virtual-rows'
import type { LineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import type { ImportedWorktreeCardActionState } from '../listing/imported-worktrees-card-actions'
import type { NewExternalWorktreesInboxActionState } from '../listing/new-external-worktrees-inbox-actions'
import type { useHostHeaderDrag } from '../drag/host-header-drag'
import { HostSectionHeader } from './HostSectionHeader'
import { renderFolderWorkspaceOption, type FolderWorkspaceRowContext } from './folder-row'
import type { LineageToggleHandler } from '../../workspace-card/identity/worktree-lineage-toggle-handler-cache'
import {
  renderImportedWorktreesVirtualRow,
  renderNewExternalWorktreesInboxVirtualRow,
  renderPendingCreationVirtualRow
} from './notice-rows'
import { renderWorktreeItemRow, type WorktreeItemRowContext } from './item-row'
import { renderWorktreeSectionHeaderRow } from './SectionHeader'
import type { SectionHeaderRowContext } from './section-header-row-context'
import type { WorktreeRowDragState } from '../drag/row-state'
import type { Translate } from '@/i18n/use-translate'

export type WorktreeVirtualRowContext = {
  dragUnitsByRow: ReadonlyMap<number, { identity: string }>
  hiddenDragRanges: readonly { start: number; end: number }[]
  projection: LineageRowProjection
  activeFamilyRoots: ReadonlySet<number>
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
  // Incoming hosts must cover the outgoing sticky group before they pin.
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
        'left-0 right-0 z-30 bg-worktree-sidebar',
        hasHeaderTopSpacing && !isActiveStickyHost && 'pt-1',
        isActiveStickyHost ? 'sticky -top-px' : 'absolute top-0'
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

function folderLineageToggle(
  ctx: WorktreeVirtualRowContext,
  row: { lineageGroupKey?: string }
): LineageToggleHandler | undefined {
  return row.lineageGroupKey ? ctx.item.getLineageToggleHandler(row.lineageGroupKey) : undefined
}

// Header frames retain sticky positioning; each workspace owns its measured slot.
export function renderWorktreeVirtualRow(
  ctx: WorktreeVirtualRowContext,
  row: RenderRow,
  vItem: VirtualItem,
  t?: Translate
): React.JSX.Element | null {
  if (row.type === 'host-header') {
    return renderHostHeaderVirtualRow(ctx, row, vItem)
  }

  if (row.type === 'header') {
    return renderWorktreeSectionHeaderRow(
      {
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
      },
      t
    )
  }

  if (row.type === 'imported-worktrees-card') {
    return renderImportedWorktreesVirtualRow({
      row,
      vItem,
      measureVirtualRowElement: ctx.measureVirtualRowElement,
      actionStateByProjectId: ctx.importedWorktreeCardActionState,
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

  const frame = ctx.projection.frames[vItem.index]
  const folder = row.type === 'folder-workspace'
  const itemWorkspaceStatus =
    !folder && ctx.groupBy === 'workspace-status'
      ? getWorkspaceStatus(row.worktree, ctx.workspaceStatuses)
      : null
  const itemKey = folder ? null : getWorktreeHostIdentity(row.worktree)
  const sourceHidden =
    itemKey !== null &&
    ctx.worktreeDragState.draggingWorktreeId !== null &&
    ctx.hiddenDragRanges.some(({ start, end }) => vItem.index >= start && vItem.index <= end)
  const itemPreviewOffset =
    (itemKey
      ? ctx.worktreeDragState.previewOffsetsByWorktreeId.get(
          ctx.dragUnitsByRow.get(vItem.index)?.identity ?? itemKey
        )
      : 0) ?? 0
  const activeFamily = ctx.activeFamilyRoots.has(frame.root)
  const rootFrame = ctx.projection.frames[frame.root]
  const rootRow = ctx.renderRows[frame.root]
  const familyHidden = ctx.hiddenDragRanges.some(
    ({ start, end }) => frame.root >= start && frame.root <= end
  )
  const familyVariant =
    rootRow.type === 'item' &&
    isActiveSidebarWorkspace(rootRow.worktree, {
      worktreeId: ctx.item.activeWorktreeId,
      hostId: ctx.item.activeWorkspaceExecutionHostId
    })
      ? ctx.item.getActiveSurfaceVariant(rootRow)
      : 'primary'

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
        activeFamily && frame.root === vItem.index && 'worktree-sidebar-family-root',
        ctx.worktreeDragState.draggingWorktreeId !== null &&
          'transition-transform duration-150 ease-out will-change-transform'
      )}
      style={{
        transform: getWorktreeVirtualRowTransform(vItem.start, itemPreviewOffset)
      }}
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
      <div
        className="relative"
        style={{ paddingTop: frame.before, paddingBottom: frame.closing + frame.after }}
      >
        {activeFamily && (
          <div
            aria-hidden="true"
            data-worktree-family-segment={familyVariant}
            className={cn(
              'pointer-events-none absolute border-x',
              familyHidden && 'opacity-0',
              frame.root === vItem.index && 'rounded-t-lg border-t',
              frame.end === vItem.index && vItem.index === rootFrame.end && 'rounded-b-lg border-b'
            )}
            style={{
              left: rootFrame.left + 4,
              right: rootFrame.right,
              top: 0,
              bottom: frame.after
            }}
          />
        )}
        <div className={cn(sourceHidden && 'pointer-events-none opacity-0')}>
          {folder
            ? renderFolderWorkspaceOption({
                ctx: ctx.folderWorkspace,
                row,
                lineage: { onToggle: folderLineageToggle(ctx, row), childIsActive: activeFamily }
              })
            : renderWorktreeItemRow(
                ctx.item,
                row,
                frame,
                activeFamily && frame.root === vItem.index
              )}
        </div>
      </div>
    </div>
  )
}
