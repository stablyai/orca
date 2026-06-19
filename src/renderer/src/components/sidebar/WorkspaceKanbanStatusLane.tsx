import React from 'react'
import { Plus } from 'lucide-react'
import type { Repo, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN
} from '../../../../shared/workspace-statuses'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import { getWorkspaceStatusVisualMeta } from './workspace-status'
import { translate } from '@/i18n/i18n'

type WorkspaceKanbanStatusLaneProps = {
  status: WorkspaceStatusDefinition
  items: readonly Worktree[]
  repoMap: Map<string, Repo>
  activeWorktreeId: string | null
  columnWidth: number
  isResizingColumn: boolean
  isDragTarget: boolean
  canCreateWorktree: boolean
  nativeDragEnabled?: boolean
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
  onCreateWorktree: (statusId: string) => void
  onColumnResizeStart: (event: React.PointerEvent<HTMLElement>) => void
  onColumnResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export default function WorkspaceKanbanStatusLane({
  status,
  items,
  repoMap,
  activeWorktreeId,
  columnWidth,
  isResizingColumn,
  isDragTarget,
  canCreateWorktree,
  nativeDragEnabled = true,
  selectedWorktreeIds,
  selectedWorktrees,
  onDragOver,
  onDragLeave,
  onDrop,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onCreateWorktree,
  onColumnResizeStart,
  onColumnResizeKeyDown
}: WorkspaceKanbanStatusLaneProps): React.JSX.Element {
  const meta = getWorkspaceStatusVisualMeta(status)
  const createTooltip = canCreateWorktree
    ? `New workspace in ${status.label}`
    : 'Add a project to create workspaces'
  const createButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6 text-muted-foreground"
      aria-label={createTooltip}
      disabled={!canCreateWorktree}
      onClick={() => onCreateWorktree(status.id)}
    >
      <Plus className="size-3.5" />
    </Button>
  )

  return (
    <section
      data-workspace-status-drop-target=""
      data-workspace-status={status.id}
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
            {items.length}
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
        data-workspace-board-lane-scroll=""
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2 scrollbar-sleek"
      >
        {items.length > 0 ? (
          <div className="space-y-2">
            {items.map((worktree) => {
              const isSelected = selectedWorktreeIds.has(worktree.id)
              return (
                <WorkspaceKanbanCard
                  key={worktree.id}
                  worktree={worktree}
                  repo={repoMap.get(worktree.repoId)}
                  isActive={activeWorktreeId === worktree.id}
                  isSelected={isSelected}
                  nativeDragEnabled={nativeDragEnabled}
                  selectedWorktrees={
                    isSelected && selectedWorktrees.length > 0 ? selectedWorktrees : undefined
                  }
                  onActivate={onActivate}
                  onSelectionGesture={onSelectionGesture}
                  onContextMenuSelect={onContextMenuSelect}
                />
              )
            })}
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
            {translate('auto.components.sidebar.WorkspaceKanbanStatusLane.8ad104642b', 'Empty')}
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
              disabled={!canCreateWorktree}
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
