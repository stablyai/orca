import React, { useMemo, useRef } from 'react'
import { Plus } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN
} from '../../../../shared/workspace-statuses'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import WorkspaceKanbanLaneCardList from './WorkspaceKanbanLaneCardList'
import { serializeWorkspaceLaneFullIds } from './workspace-kanban-filtered-drop-index'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanStatusLaneProps = {
  status: WorkspaceStatusDefinition
  items: readonly Worktree[]
  /** Lane membership before search filtering; defaults to the rendered items. */
  totalCount?: number
  hasQuery?: boolean
  fullWorktreeIds?: readonly string[]
  repoMap: Map<string, Repo>
  activeWorktreeIdentity: string | null
  columnWidth: number
  isResizingColumn: boolean
  isDragTarget: boolean
  nativeDragEnabled?: boolean
  renderCards: boolean
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onDragOver: (event: React.DragEvent, statusId: string) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent, statusId: string) => void
  onActivate: () => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktreeId: string) => boolean
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
  onCreateWorktree: (statusId: string) => void
  onColumnResizeStart: (event: React.PointerEvent<HTMLElement>) => void
  onColumnResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

function WorkspaceKanbanStatusLane({
  status,
  items,
  totalCount,
  hasQuery = false,
  fullWorktreeIds,
  repoMap,
  activeWorktreeIdentity,
  columnWidth,
  isResizingColumn,
  isDragTarget,
  nativeDragEnabled = true,
  renderCards,
  selectedWorktreeIds,
  selectedWorktrees,
  onDragOver,
  onDragLeave,
  onDrop,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onAssignWorkspaceStatus,
  onCreateWorktree,
  onColumnResizeStart,
  onColumnResizeKeyDown
}: WorkspaceKanbanStatusLaneProps): React.JSX.Element {
  const laneScrollRef = useRef<HTMLDivElement | null>(null)
  const meta = getWorkspaceStatusVisualMeta(status)
  // Why: a lane that is empty on its own merits is still "Empty" under a query —
  // only a lane whose cards were filtered away has anything to say about matches.
  const laneTotalCount = totalCount ?? items.length
  const isFiltered = hasQuery && laneTotalCount > 0
  // Why: this joins every id in the lane, so it must not rerun on unrelated
  // board re-renders — at a few hundred cards it is ~25KB of string per pass.
  const laneFullIdsAttribute = useMemo(() => {
    if (!hasQuery) {
      return undefined
    }
    return (
      serializeWorkspaceLaneFullIds(fullWorktreeIds ?? items.map((worktree) => worktree.id)) ??
      undefined
    )
  }, [fullWorktreeIds, hasQuery, items])
  const createTooltip = `New workspace in ${status.label}`
  const createButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6 text-muted-foreground"
      aria-label={createTooltip}
      onClick={() => onCreateWorktree(status.id)}
    >
      <Plus className="size-3.5" />
    </Button>
  )

  return (
    <section
      data-workspace-status-drop-target=""
      data-workspace-status={status.id}
      // Why: sidebar→board drops read lane membership straight out of the DOM,
      // where a search query would otherwise leave them only the rendered cards.
      // Unfiltered lanes stay off this channel — the rendered scan already is the
      // full lane, and every board id in an attribute is real DOM weight.
      data-workspace-lane-full-ids={laneFullIdsAttribute}
      data-contextual-tour-target={
        status.id === 'completed' ? 'workspace-board-done-lane' : undefined
      }
      className={cn(
        'group/lane',
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-t-2 border-worktree-sidebar-border transition-colors',
        meta.border,
        meta.laneTint,
        isDragTarget && 'border-worktree-sidebar-ring bg-worktree-sidebar-accent/70',
        'data-[workspace-board-external-drag-target=true]:border-worktree-sidebar-ring data-[workspace-board-external-drag-target=true]:bg-worktree-sidebar-accent/70'
      )}
      onDragOver={(event) => onDragOver(event, status.id)}
      onDragLeave={onDragLeave}
      onDrop={(event) => onDrop(event, status.id)}
    >
      <div
        data-workspace-board-column-resize-handle=""
        role="separator"
        aria-orientation="vertical"
        aria-label={translate(
          'auto.components.sidebar.WorkspaceKanbanStatusLane.3611d1ae7f',
          'Resize workspace board columns'
        )}
        aria-valuemin={WORKSPACE_BOARD_COLUMN_WIDTH_MIN}
        aria-valuemax={WORKSPACE_BOARD_COLUMN_WIDTH_MAX}
        aria-valuenow={columnWidth}
        tabIndex={0}
        className={cn(
          'group absolute right-0 top-0 z-20 h-9 w-2 cursor-col-resize outline-none',
          'focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring',
          isResizingColumn && 'cursor-col-resize'
        )}
        onPointerDown={onColumnResizeStart}
        onKeyDown={onColumnResizeKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          className={cn(
            'absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors',
            'group-hover:bg-worktree-sidebar-ring/55 group-focus-visible:bg-worktree-sidebar-ring',
            isResizingColumn && 'bg-worktree-sidebar-ring'
          )}
        />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 py-0 pl-3 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <meta.icon className={cn('size-3.5 shrink-0', meta.tone)} />
          <div className="min-w-0 truncate text-[12px] font-semibold text-foreground">
            {status.label}
          </div>
          <div className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
            {isFiltered ? `${items.length} / ${laneTotalCount}` : items.length}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>{createButton}</TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {createTooltip}
          </TooltipContent>
        </Tooltip>
      </div>

      <div
        ref={laneScrollRef}
        data-workspace-board-lane-scroll=""
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2 scrollbar-sleek"
      >
        {items.length > 0 ? (
          renderCards ? (
            <WorkspaceKanbanLaneCardList
              items={items}
              repoMap={repoMap}
              activeWorktreeIdentity={activeWorktreeIdentity}
              scrollRef={laneScrollRef}
              selectedWorktreeIds={selectedWorktreeIds}
              selectedWorktrees={selectedWorktrees}
              nativeDragEnabled={nativeDragEnabled}
              onActivate={onActivate}
              onSelectionGesture={onSelectionGesture}
              onContextMenuSelect={onContextMenuSelect}
              onAssignWorkspaceStatus={onAssignWorkspaceStatus}
            />
          ) : null
        ) : (
          <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
            {isFiltered
              ? translate(
                  'auto.components.sidebar.WorkspaceKanbanStatusLane.2df01a03ff',
                  'No matches'
                )
              : translate('auto.components.sidebar.WorkspaceKanbanStatusLane.8ad104642b', 'Empty')}
          </div>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className={cn(
                'mt-2 h-7 w-full can-hover:opacity-0 transition-opacity',
                'group-hover/lane:opacity-100 group-focus-within/lane:opacity-100'
              )}
              aria-label={createTooltip}
              onClick={() => onCreateWorktree(status.id)}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {createTooltip}
          </TooltipContent>
        </Tooltip>
      </div>
    </section>
  )
}

export default React.memo(WorkspaceKanbanStatusLane)
