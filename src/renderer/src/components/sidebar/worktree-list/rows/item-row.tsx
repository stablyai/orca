import React from 'react'
import { cn } from '@/lib/utils'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import WorktreeCard, { type ActiveSurfaceVariant } from '../../WorktreeCard'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'
import type { WorktreeGroupBy } from '../grouping/row-types'
import {
  getFolderBackedRepoWorktreeCardContentIndent,
  getFolderBackedRepoWorktreeCardSurfaceInset,
  getLineageChildrenInlineStyle,
  getLineageNestedRowGeometry,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from './indentation'
import type { LineageToggleHandler } from '../../worktree-lineage-toggle-handler-cache'
import { stopNestedWorktreeCardBubble } from './header-event-guards'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { getWorktreeOptionId } from './option-dom'
import type { WorktreePointerDrag, WorktreeRowDragState } from '../drag/row-state'

export type WorktreeItemRowContext = {
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  folderBackedProjectGroupIds: ReadonlySet<string>
  groupKeyByRowKey: ReadonlyMap<string, string>
  groupIndexByRowKey: ReadonlyMap<string, number>
  agentSendTargetWorktreeId: string | null
  worktreeDragState: WorktreeRowDragState
  worktreePointerDragRef: React.MutableRefObject<WorktreePointerDrag | null>
  nativeLineageDropTargetId: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  currentWorktreeId: string | null
  highlightedRevealRowKey: string | null
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  getActiveSurfaceVariant: (row: WorktreeItemRow) => ActiveSurfaceVariant
  getLineageToggleHandler: (groupKey: string) => LineageToggleHandler
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
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
    draggedIds: readonly string[]
  ) => void
  onCardDragEnd: () => void
}

// Geometry differs three ways: a plain grouped row, a lineage child inheriting its parent's
// surface, and a row inside a folder-backed project group.
function getWorktreeItemRowGeometry(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean
): { surfaceInset: number; cardContentIndent: number; lineageChildrenInlineOffset?: number } {
  const projectGroupId = itemRow.repo?.projectGroupId
  const isFolderBackedRepoChild =
    ctx.groupBy === 'repo' &&
    Boolean(projectGroupId && ctx.folderBackedProjectGroupIds.has(projectGroupId))
  // Why: experimental in-card lineage inherits the parent surface; legacy cards keep depth-based nested geometry.
  const paddingDepth = nested ? Math.max(0, itemRow.depth - 1) : itemRow.depth
  const getCardContentIndent = (lineageDepth: number): number =>
    isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardContentIndent({
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
      : getWorktreeCardContentIndent({
          isGrouped: ctx.groupBy !== 'none',
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
  const nestedLineageGeometry = nested
    ? getLineageNestedRowGeometry({
        experimentalNewWorktreeCardStyle: ctx.settings?.experimentalNewWorktreeCardStyle === true,
        inheritedCardContentIndent: getCardContentIndent(0),
        lineageDepth: itemRow.depth
      })
    : null
  // Why: grouped rows inherit their header depth, but the card surface still spans the full row.
  const paddingLeft =
    nested && ctx.groupBy !== 'none'
      ? getWorktreeCardContentIndent({
          isGrouped: false,
          groupDepth: itemRow.groupDepth,
          lineageDepth: paddingDepth
        })
      : getCardContentIndent(paddingDepth)
  const surfaceInset = nestedLineageGeometry
    ? nestedLineageGeometry.surfaceInset
    : isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardSurfaceInset({
          groupDepth: itemRow.groupDepth,
          lineageDepth: paddingDepth
        })
      : getWorktreeCardSurfaceInset({
          isGrouped: ctx.groupBy !== 'none',
          groupDepth: itemRow.groupDepth
        })
  return {
    surfaceInset,
    cardContentIndent: nestedLineageGeometry
      ? nestedLineageGeometry.cardContentIndent
      : Math.max(0, paddingLeft - surfaceInset),
    lineageChildrenInlineOffset: nestedLineageGeometry?.lineageChildrenInlineOffset
  }
}

export function renderWorktreeItemRow(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean,
  lineageChildren?: React.ReactNode,
  forceActiveSurface = false
): React.JSX.Element {
  const { surfaceInset, cardContentIndent, lineageChildrenInlineOffset } =
    getWorktreeItemRowGeometry(ctx, itemRow, nested)
  const lineageChildrenStyle = lineageChildren
    ? getLineageChildrenInlineStyle(lineageChildrenInlineOffset ?? LINEAGE_CHILDREN_INLINE_OFFSET)
    : undefined
  const worktreeDragGroupKey = ctx.groupKeyByRowKey.get(itemRow.rowKey)
  const worktreeIdentity = getWorktreeHostIdentity(itemRow.worktree)
  const isLineageDropTarget =
    ctx.worktreeDragState.draggingWorktreeId &&
    (ctx.worktreePointerDragRef.current?.latestStatusDropTarget?.target.lineageParentId ===
      itemRow.worktree.id ||
      ctx.nativeLineageDropTargetId === itemRow.worktree.id)
  const isActiveWorktree =
    ctx.activeWorktreeId === itemRow.worktree.id &&
    (!ctx.activeWorkspaceExecutionHostId ||
      worktreeIdentity ===
        composeWorktreeHostIdentity(ctx.activeWorkspaceExecutionHostId, itemRow.worktree.id))
  return (
    <div
      key={itemRow.rowKey}
      id={getWorktreeOptionId(itemRow.rowKey)}
      role="option"
      aria-selected={ctx.selectedWorktreeIds.has(worktreeIdentity)}
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
        ctx.worktreeDragState.draggingWorktreeId === itemRow.worktree.id &&
          // Why: the fixed drag preview is the affordance; a translucent source row would bleed through sticky headers/footers.
          'pointer-events-none opacity-0'
      )}
      data-scroll-reveal-highlight={
        ctx.highlightedRevealRowKey === itemRow.rowKey ? 'true' : undefined
      }
      // Why: nested child cards live inside the parent's clickable body; bubbling would activate/edit the parent too.
      onClick={nested ? stopNestedWorktreeCardBubble : undefined}
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
        isMultiSelected={ctx.selectedWorktreeIds.has(worktreeIdentity)}
        revealHighlight={ctx.highlightedRevealRowKey === itemRow.rowKey}
        revealHighlightTone={
          ctx.agentSendTargetWorktreeId === itemRow.worktree.id ? 'ai' : 'default'
        }
        selectedWorktrees={ctx.selectedWorktrees}
        nativeDragEnabled={false}
        isLineageDropTarget={Boolean(isLineageDropTarget)}
        contentIndent={cardContentIndent}
        flushSurface
        activationRowKey={itemRow.rowKey}
        onImmediateActivate={ctx.onImmediateActivate}
        onSelectionGesture={ctx.onSelectionGesture}
        onContextMenuSelect={ctx.onContextMenuSelect}
        onCardDragStart={ctx.onCardDragStart}
        onCardDragEnd={ctx.onCardDragEnd}
        hideRepoBadge={ctx.groupBy === 'repo'}
        // Why: pinned worktrees mix repos in one section, so only it needs the leading repo identity chip.
        hostContextLabel={itemRow.hostContextLabel}
        inPinnedSection={itemRow.sectionKey === PINNED_GROUP_KEY}
        renameRowKey={itemRow.rowKey}
        lineageChildCount={itemRow.lineageChildCount}
        lineageCollapsed={itemRow.lineageCollapsed}
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
  parent: WorktreeItemRow,
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
