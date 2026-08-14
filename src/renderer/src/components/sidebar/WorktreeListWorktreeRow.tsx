import type React from 'react'
import type { AppState } from '@/store/types'
import { cn } from '@/lib/utils'
import WorktreeCard, { type ActiveSurfaceVariant } from './WorktreeCard'
import { PINNED_GROUP_KEY, type WorktreeGroupBy } from './worktree-list-groups'
import type { WorktreeItemRow } from './worktree-list-render-row-model'
import {
  LINEAGE_CHILDREN_INLINE_OFFSET,
  getFolderBackedRepoWorktreeCardContentIndent,
  getFolderBackedRepoWorktreeCardSurfaceInset,
  getLineageChildrenInlineStyle,
  getLineageNestedRowGeometry,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset
} from './worktree-list-indentation'
import { getWorktreeOptionId } from './worktree-list-dom-activation'
import type { WorktreePointerDrag, WorktreeRowDragState } from './worktree-list-drag-model'

type CardProps = React.ComponentProps<typeof WorktreeCard>
type Props = {
  itemRow: WorktreeItemRow
  nested: boolean
  lineageChildren?: React.ReactNode
  forceActiveSurface?: boolean
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
  currentWorktreeId: string | null
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: CardProps['selectedWorktrees']
  highlightedRevealRowKey: string | null
  getActiveSurfaceVariant: (row: WorktreeItemRow) => ActiveSurfaceVariant
  handleWorktreeRowClickCapture: React.MouseEventHandler<HTMLDivElement>
  handleWorktreeRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktreeId: string,
    rowKey: string
  ) => void
  handleImmediateWorktreeRowActivate: CardProps['onImmediateActivate']
  onSelectionGesture: CardProps['onSelectionGesture']
  onContextMenuSelect: CardProps['onContextMenuSelect']
  handleWorktreeCardDragStart: NonNullable<CardProps['onCardDragStart']>
  clearWorktreeDrag: () => void
  getLineageToggleHandler: (groupKey: string) => NonNullable<CardProps['onLineageToggle']>
}

function stopNestedWorktreeCardBubble(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation()
}

export function WorktreeListWorktreeRow({
  itemRow,
  nested,
  lineageChildren,
  forceActiveSurface = false,
  settings,
  groupBy,
  folderBackedProjectGroupIds,
  groupKeyByRowKey,
  groupIndexByRowKey,
  agentSendTargetWorktreeId,
  worktreeDragState,
  worktreePointerDragRef,
  nativeLineageDropTargetId,
  activeWorktreeId,
  currentWorktreeId,
  selectedWorktreeIds,
  selectedWorktrees,
  highlightedRevealRowKey,
  getActiveSurfaceVariant,
  handleWorktreeRowClickCapture,
  handleWorktreeRowPointerDown,
  handleImmediateWorktreeRowActivate,
  onSelectionGesture,
  onContextMenuSelect,
  handleWorktreeCardDragStart,
  clearWorktreeDrag,
  getLineageToggleHandler
}: Props): React.JSX.Element {
  const lineageToggleGroupKey = itemRow.lineageGroupKey
  const experimentalNewWorktreeCardStyle = settings?.experimentalNewWorktreeCardStyle === true
  const projectGroupId = itemRow.repo?.projectGroupId
  const isFolderBackedRepoChild =
    groupBy === 'repo' && Boolean(projectGroupId && folderBackedProjectGroupIds.has(projectGroupId))
  // Why: experimental in-card lineage inherits the parent surface; legacy cards keep depth-based nested geometry.
  const paddingDepth = nested ? Math.max(0, itemRow.depth - 1) : itemRow.depth
  const getCardContentIndent = (lineageDepth: number): number =>
    isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardContentIndent({
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
      : getWorktreeCardContentIndent({
          isGrouped: groupBy !== 'none',
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
  const inheritedCardContentIndent = getCardContentIndent(0)
  const nestedLineageGeometry = nested
    ? getLineageNestedRowGeometry({
        experimentalNewWorktreeCardStyle,
        inheritedCardContentIndent,
        lineageDepth: itemRow.depth
      })
    : null
  // Why: grouped rows inherit their header depth, but the card surface still spans the full row.
  const paddingLeft =
    nested && groupBy !== 'none'
      ? getWorktreeCardContentIndent({
          isGrouped: false,
          groupDepth: itemRow.groupDepth,
          lineageDepth: paddingDepth
        })
      : getCardContentIndent(paddingDepth)
  const surfaceInset = nested
    ? nestedLineageGeometry!.surfaceInset
    : isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardSurfaceInset({
          groupDepth: itemRow.groupDepth,
          lineageDepth: paddingDepth
        })
      : getWorktreeCardSurfaceInset({
          isGrouped: groupBy !== 'none',
          groupDepth: itemRow.groupDepth
        })
  const cardContentIndent = nested
    ? nestedLineageGeometry!.cardContentIndent
    : Math.max(0, paddingLeft - surfaceInset)
  const lineageChildrenStyle = lineageChildren
    ? getLineageChildrenInlineStyle(
        nestedLineageGeometry?.lineageChildrenInlineOffset ?? LINEAGE_CHILDREN_INLINE_OFFSET
      )
    : undefined
  const worktreeDragGroupKey = groupKeyByRowKey.get(itemRow.rowKey)
  const isActiveWorktree = activeWorktreeId === itemRow.worktree.id
  const isLineageDropTarget =
    worktreeDragState.draggingWorktreeId &&
    (worktreePointerDragRef.current?.latestStatusDropTarget?.target.lineageParentId ===
      itemRow.worktree.id ||
      nativeLineageDropTargetId === itemRow.worktree.id)
  return (
    <div
      key={itemRow.rowKey}
      id={getWorktreeOptionId(itemRow.rowKey)}
      role="option"
      aria-selected={selectedWorktreeIds.has(itemRow.worktree.id)}
      aria-current={isActiveWorktree ? 'page' : undefined}
      data-worktree-id={itemRow.worktree.id}
      data-worktree-row-key={itemRow.rowKey}
      data-worktree-section-key={itemRow.sectionKey}
      data-worktree-drag-id={worktreeDragGroupKey ? itemRow.worktree.id : undefined}
      data-worktree-drag-group-key={worktreeDragGroupKey}
      data-worktree-drag-group-index={groupIndexByRowKey.get(itemRow.rowKey)}
      className={cn(
        // Why: don't transition 'transform' — it lags/flashes when TanStack Virtual repositions adjacent rows.
        'relative transition-[opacity,filter] duration-150 ease-out',
        worktreeDragState.draggingWorktreeId === itemRow.worktree.id &&
          // Why: the fixed drag preview is the affordance; a translucent source row would bleed through sticky headers/footers.
          'pointer-events-none opacity-0'
      )}
      data-scroll-reveal-highlight={highlightedRevealRowKey === itemRow.rowKey ? 'true' : undefined}
      // Why: nested child cards live inside the parent's clickable body; bubbling would activate/edit the parent too.
      onClick={nested ? stopNestedWorktreeCardBubble : undefined}
      onClickCapture={handleWorktreeRowClickCapture}
      onDoubleClick={nested ? stopNestedWorktreeCardBubble : undefined}
      onDragStart={nested ? stopNestedWorktreeCardBubble : undefined}
      onPointerDown={(event) => {
        if (nested) {
          event.stopPropagation()
        }
        handleWorktreeRowPointerDown(event, itemRow.worktree.id, itemRow.rowKey)
      }}
      style={{ paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined }}
    >
      <WorktreeCard
        worktree={itemRow.worktree}
        repo={itemRow.repo}
        isActive={isActiveWorktree}
        isCurrentWorktree={currentWorktreeId === itemRow.worktree.id}
        // Why: a child-active parent should look active without the active-card side effects (e.g. SSH reconnect UI).
        isActiveSurface={forceActiveSurface || isActiveWorktree}
        activeSurfaceVariant={
          isActiveWorktree && !forceActiveSurface ? getActiveSurfaceVariant(itemRow) : 'primary'
        }
        isMultiSelected={selectedWorktreeIds.has(itemRow.worktree.id)}
        revealHighlight={highlightedRevealRowKey === itemRow.rowKey}
        revealHighlightTone={agentSendTargetWorktreeId === itemRow.worktree.id ? 'ai' : 'default'}
        selectedWorktrees={selectedWorktrees}
        nativeDragEnabled={false}
        isLineageDropTarget={Boolean(isLineageDropTarget)}
        contentIndent={cardContentIndent}
        flushSurface
        activationRowKey={itemRow.rowKey}
        onImmediateActivate={handleImmediateWorktreeRowActivate}
        onSelectionGesture={onSelectionGesture}
        onContextMenuSelect={onContextMenuSelect}
        onCardDragStart={handleWorktreeCardDragStart}
        onCardDragEnd={clearWorktreeDrag}
        hideRepoBadge={groupBy === 'repo'}
        // Why: pinned worktrees mix repos in one section, so only it needs the leading repo identity chip.
        hostContextLabel={itemRow.hostContextLabel}
        inPinnedSection={itemRow.sectionKey === PINNED_GROUP_KEY}
        renameRowKey={itemRow.rowKey}
        lineageChildCount={itemRow.lineageChildCount}
        lineageCollapsed={itemRow.lineageCollapsed}
        lineageChildren={lineageChildren}
        lineageChildrenStyle={lineageChildrenStyle}
        onLineageToggle={
          lineageToggleGroupKey ? getLineageToggleHandler(lineageToggleGroupKey) : undefined
        }
      />
    </div>
  )
}
