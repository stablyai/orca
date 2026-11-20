import type { DraggedWorktreeCopies } from '../drag/dragged-worktree-copies'
import React from 'react'
import { cn } from '@/lib/class-names'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/selection/active-workspace'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { LineageToggleHandler } from '../../workspace-card/identity/worktree-lineage-toggle-handler-cache'
import type { LineageRowFrame } from '../listing/lineage-row-projection'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { forwardOptionPressToCardSurface, getWorktreeOptionId } from './option-dom'
import type { WorktreeRowDragState } from '../drag/row-state'
import { ProjectHeaderActions } from './ProjectHeaderActions'
import {
  RepoProjectActionButtons,
  type RepoHeaderProjectActions
} from './repo-header-project-actions'
import { stopNestedWorktreeCardBubble } from './header-event-guards'

export type WorktreeItemRowContext = {
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  projectActions: RepoHeaderProjectActions
  projectGroups: readonly ProjectGroup[]
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

export function renderWorktreeItemRow(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  frame: LineageRowFrame,
  forceActiveSurface = false
): React.JSX.Element {
  const { left: surfaceInset, right, contentIndent: cardContentIndent } = frame
  const { repo, inlineProjectName } = itemRow
  const showProjectActions = repo !== undefined && inlineProjectName !== undefined
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
        showProjectActions && 'group/sidebar-workspace',
        ctx.worktreeDragState.draggingWorktreeId === worktreeIdentity &&
          // Why: the fixed drag preview is the affordance; a translucent source row would bleed through sticky headers/footers.
          'pointer-events-none opacity-0'
      )}
      data-scroll-reveal-highlight={
        ctx.highlightedRevealRowKey === itemRow.rowKey ? 'true' : undefined
      }
      onClick={forwardOptionPressToCardSurface}
      onClickCapture={ctx.onRowClickCapture}
      onPointerDown={(event) => {
        ctx.onRowPointerDown(event, itemRow.worktree, itemRow.rowKey)
      }}
      style={{
        paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined,
        paddingRight: right || undefined
      }}
    >
      <WorktreeCard
        worktree={itemRow.worktree}
        repo={repo}
        isActive={isActiveWorktree}
        isCurrentWorktree={ctx.currentWorktreeId === itemRow.worktree.id}
        // Why: a child-active parent should look active without the active-card side effects (e.g. SSH reconnect UI).
        isActiveSurface={forceActiveSurface || isActiveWorktree}
        activeSurfaceVariant={isActiveWorktree ? ctx.getActiveSurfaceVariant(itemRow) : 'primary'}
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
        inlineProjectName={inlineProjectName}
        projectActions={
          showProjectActions ? (
            <ProjectHeaderActions
              inline
              onPointerDown={stopNestedWorktreeCardBubble}
              onClick={stopNestedWorktreeCardBubble}
              onDoubleClick={stopNestedWorktreeCardBubble}
            >
              <RepoProjectActionButtons
                repo={repo}
                label={inlineProjectName}
                projectGroups={ctx.projectGroups}
                actions={ctx.projectActions}
                pinHost
              />
            </ProjectHeaderActions>
          ) : undefined
        }
        // Why: pinned worktrees mix repos; cross-repo children opt into the existing project-name badge.
        hostContextLabel={itemRow.hostContextLabel}
        showProjectName={itemRow.showProjectName}
        inPinnedSection={itemRow.sectionKey === PINNED_GROUP_KEY}
        renameRowKey={itemRow.rowKey}
        lineageChildCount={itemRow.lineageChildCount}
        lineageChildWorktreeIds={itemRow.lineageChildWorktreeIds}
        lineageCollapsed={itemRow.lineageCollapsed}
        lineageDescendantIdentities={itemRow.lineageDescendantIdentities}
        onLineageToggle={
          itemRow.lineageGroupKey ? ctx.getLineageToggleHandler(itemRow.lineageGroupKey) : undefined
        }
      />
    </div>
  )
}
