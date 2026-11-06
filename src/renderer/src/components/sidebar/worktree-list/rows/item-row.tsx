import type { DraggedWorktreeCopies } from '../drag/dragged-worktree-copies'
import React from 'react'
import { cn } from '@/lib/utils'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/active-workspace'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getLineageChildrenInlineStyle,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset,
  LINEAGE_CHILDREN_INLINE_OFFSET,
  LINEAGE_NESTED_ROW_SURFACE_INSET
} from './indentation'
import type { LineageToggleHandler } from '../../workspace-card/identity/worktree-lineage-toggle-handler-cache'
import { stopNestedWorktreeCardBubble } from './header-event-guards'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { forwardOptionPressToCardSurface, getWorktreeOptionId } from './option-dom'
import type { WorktreeRowDragState } from '../drag/row-state'

export type WorktreeItemRowContext = {
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  groupKeyByRowKey: ReadonlyMap<string, string>
  groupIndexByRowKey: ReadonlyMap<string, number>
  agentSendTargetWorktreeId: string | null
  worktreeDragState: WorktreeRowDragState
  nativeLineageDropTargetIdentity: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  currentWorktreeId: string | null
  highlightedRevealRowKey: string | null
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  getActiveSurfaceVariant: (row: WorktreeItemRow) => ActiveSurfaceVariant
  getLineageToggleHandler: (groupKey: string) => LineageToggleHandler
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onWorktreeCardClick?: () => void
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
  onRowClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktree: Worktree,
    rowKey: string
  ) => void
  onCardDragStart: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedCopies: DraggedWorktreeCopies
  ) => void
  onCardDragEnd: () => void
}

// Handle plain rows and inherited lineage offsets separately.
function getWorktreeItemRowGeometry(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean
): { surfaceInset: number; cardContentIndent: number } {
  // Why: the shared child wrapper already inherits the parent's group and content offsets.
  if (nested) {
    return { surfaceInset: LINEAGE_NESTED_ROW_SURFACE_INSET, cardContentIndent: 0 }
  }

  const isGrouped = ctx.groupBy !== 'none'
  const paddingLeft = getWorktreeCardContentIndent({
    isGrouped,
    groupDepth: itemRow.groupDepth,
    lineageDepth: itemRow.depth
  })
  const surfaceInset = getWorktreeCardSurfaceInset({ isGrouped, groupDepth: itemRow.groupDepth })
  return {
    surfaceInset,
    cardContentIndent: Math.max(0, paddingLeft - surfaceInset)
  }
}

export function renderWorktreeItemRow(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean,
  lineageChildren?: React.ReactNode,
  forceActiveSurface = false
): React.JSX.Element {
  const { surfaceInset, cardContentIndent } = getWorktreeItemRowGeometry(ctx, itemRow, nested)
  const lineageChildrenStyle = lineageChildren
    ? getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
    : undefined
  const worktreeDragGroupKey = ctx.groupKeyByRowKey.get(itemRow.rowKey)
  const worktreeIdentity = getWorktreeHostIdentity(itemRow.worktree)
  const isMultiSelected = ctx.selectedWorktreeIds.has(worktreeIdentity)
  const isLineageDropTarget =
    ctx.worktreeDragState.draggingWorktreeId &&
    (ctx.worktreeDragState.lineageDropTargetIdentity === worktreeIdentity ||
      ctx.nativeLineageDropTargetIdentity === worktreeIdentity)
  const isActiveWorktree = isActiveSidebarWorkspace(itemRow.worktree, {
    worktreeId: ctx.activeWorktreeId,
    hostId: ctx.activeWorkspaceExecutionHostId ?? null
  })
  return (
    <div
      key={itemRow.rowKey}
      id={getWorktreeOptionId(itemRow.rowKey)}
      role="option"
      aria-selected={isMultiSelected}
      aria-current={isActiveWorktree ? 'page' : undefined}
      data-worktree-id={itemRow.worktree.id}
      data-worktree-host-identity={worktreeIdentity}
      data-worktree-row-key={itemRow.rowKey}
      data-worktree-section-key={itemRow.sectionKey}
      data-worktree-drag-id={worktreeDragGroupKey ? itemRow.worktree.id : undefined}
      data-worktree-drag-group-key={worktreeDragGroupKey}
      data-worktree-drag-group-index={ctx.groupIndexByRowKey.get(itemRow.rowKey)}
      className={cn(
        // Why: don't transition 'transform' — it lags/flashes when TanStack Virtual repositions adjacent rows.
        'relative transition-[opacity,filter] duration-150 ease-out',
        ctx.worktreeDragState.draggingWorktreeId === worktreeIdentity &&
          // Why: the fixed drag preview is the affordance; a translucent source row would bleed through sticky headers/footers.
          'pointer-events-none opacity-0'
      )}
      data-scroll-reveal-highlight={
        ctx.highlightedRevealRowKey === itemRow.rowKey ? 'true' : undefined
      }
      onClick={(event) => {
        forwardOptionPressToCardSurface(event)
        // Why: nested child cards live inside the parent's clickable body; bubbling would activate/edit the parent too.
        if (nested) {
          event.stopPropagation()
        }
      }}
      onClickCapture={ctx.onRowClickCapture}
      onDoubleClick={nested ? stopNestedWorktreeCardBubble : undefined}
      onDragStart={nested ? stopNestedWorktreeCardBubble : undefined}
      onPointerDown={(event) => {
        if (nested) {
          event.stopPropagation()
        }
        ctx.onRowPointerDown(event, itemRow.worktree, itemRow.rowKey)
      }}
      style={{
        paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined
      }}
    >
      <WorktreeCard
        worktree={itemRow.worktree}
        repo={itemRow.repo}
        isActive={isActiveWorktree}
        isCurrentWorktree={ctx.currentWorktreeId === itemRow.worktree.id}
        // Why: a child-active parent should look active without the active-card side effects (e.g. SSH reconnect UI).
        isActiveSurface={forceActiveSurface || isActiveWorktree}
        activeSurfaceVariant={
          isActiveWorktree && !forceActiveSurface ? ctx.getActiveSurfaceVariant(itemRow) : 'primary'
        }
        isMultiSelected={isMultiSelected}
        revealHighlight={ctx.highlightedRevealRowKey === itemRow.rowKey}
        revealHighlightTone={
          ctx.agentSendTargetWorktreeId === itemRow.worktree.id ? 'ai' : 'default'
        }
        // Only selected rows act on the selection; passing it to the rest would re-render every card per click.
        selectedWorktrees={isMultiSelected ? ctx.selectedWorktrees : undefined}
        nativeDragEnabled={false}
        isLineageDropTarget={Boolean(isLineageDropTarget)}
        contentIndent={cardContentIndent}
        flushSurface
        activationRowKey={itemRow.rowKey}
        onImmediateActivate={ctx.onImmediateActivate}
        onSelectionGesture={ctx.onSelectionGesture}
        onWorktreeCardClick={ctx.onWorktreeCardClick}
        onContextMenuSelect={ctx.onContextMenuSelect}
        onCardDragStart={ctx.onCardDragStart}
        onCardDragEnd={ctx.onCardDragEnd}
        hideRepoBadge={ctx.groupBy === 'repo' && !itemRow.showProjectName}
        // Why: pinned worktrees mix repos; cross-repo children opt into the existing project-name badge.
        hostContextLabel={itemRow.hostContextLabel}
        showProjectName={itemRow.showProjectName}
        inPinnedSection={itemRow.sectionKey === PINNED_GROUP_KEY}
        renameRowKey={itemRow.rowKey}
        lineageChildCount={itemRow.lineageChildCount}
        lineageChildWorktreeIds={itemRow.lineageChildWorktreeIds}
        lineageChildIdentities={itemRow.lineageChildIdentities}
        lineageCollapsed={itemRow.lineageCollapsed}
        lineageDescendantIdentities={itemRow.lineageDescendantIdentities}
        lineageChildren={lineageChildren}
        lineageChildrenStyle={lineageChildrenStyle}
        onLineageToggle={
          itemRow.lineageGroupKey ? ctx.getLineageToggleHandler(itemRow.lineageGroupKey) : undefined
        }
      />
    </div>
  )
}

// Rebuild the visible lineage subtree so each card renders its own children inline.
export function renderWorktreeLineageDescendants(
  ctx: WorktreeItemRowContext,
  parent: { depth: number },
  descendants: readonly WorktreeItemRow[]
): React.ReactNode | undefined {
  const childNodes: React.ReactNode[] = []
  let cursor = 0
  while (cursor < descendants.length) {
    const child = descendants[cursor]
    if (!child || child.depth !== parent.depth + 1) {
      cursor++
      continue
    }

    let nextSiblingIndex = cursor + 1
    while (
      nextSiblingIndex < descendants.length &&
      descendants[nextSiblingIndex]!.depth > child.depth
    ) {
      nextSiblingIndex++
    }

    const childLineageChildren = renderWorktreeLineageDescendants(
      ctx,
      child,
      descendants.slice(cursor + 1, nextSiblingIndex)
    )
    childNodes.push(renderWorktreeItemRow(ctx, child, true, childLineageChildren))
    cursor = nextSiblingIndex
  }
  return childNodes.length > 0 ? childNodes : undefined
}
