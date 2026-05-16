import React from 'react'
import type { Repo, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN
} from '../../../../shared/workspace-statuses'
import { cn } from '@/lib/utils'
import WorkspaceKanbanCard from './WorkspaceKanbanCard'
import { getWorkspaceStatusVisualMeta } from './workspace-status'

type WorkspaceKanbanStatusLaneProps = {
  status: WorkspaceStatusDefinition
  items: readonly Worktree[]
  repoMap: Map<string, Repo>
  activeWorktreeId: string | null
  compact: boolean
  columnWidth: number
  isResizingColumn: boolean
  isDragTarget: boolean
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
  onColumnResizeStart: (event: React.PointerEvent<HTMLElement>) => void
  onColumnResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export default function WorkspaceKanbanStatusLane({
  status,
  items,
  repoMap,
  activeWorktreeId,
  compact,
  columnWidth,
  isResizingColumn,
  isDragTarget,
  selectedWorktreeIds,
  selectedWorktrees,
  onDragOver,
  onDragLeave,
  onDrop,
  onActivate,
  onSelectionGesture,
  onContextMenuSelect,
  onColumnResizeStart,
  onColumnResizeKeyDown
}: WorkspaceKanbanStatusLaneProps): React.JSX.Element {
  const meta = getWorkspaceStatusVisualMeta(status)

  return (
    <section
      data-workspace-status-drop-target=""
      data-workspace-status={status.id}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-t-2 border-sidebar-border transition-colors',
        meta.border,
        meta.laneTint,
        isDragTarget && 'border-sidebar-ring bg-sidebar-accent/70'
      )}
      onDragOver={(event) => onDragOver(event, status.id)}
      onDragLeave={onDragLeave}
      onDrop={(event) => onDrop(event, status.id)}
    >
      <div
        data-workspace-board-column-resize-handle=""
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workspace board columns"
        aria-valuemin={WORKSPACE_BOARD_COLUMN_WIDTH_MIN}
        aria-valuemax={WORKSPACE_BOARD_COLUMN_WIDTH_MAX}
        aria-valuenow={columnWidth}
        tabIndex={0}
        className={cn(
          'group absolute right-0 top-0 z-20 h-9 w-2 cursor-col-resize outline-none',
          'focus-visible:ring-1 focus-visible:ring-sidebar-ring',
          isResizingColumn && 'cursor-col-resize'
        )}
        onPointerDown={onColumnResizeStart}
        onKeyDown={onColumnResizeKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <span
          className={cn(
            'absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors',
            'group-hover:bg-sidebar-ring/55 group-focus-visible:bg-sidebar-ring',
            isResizingColumn && 'bg-sidebar-ring'
          )}
        />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <meta.icon className={cn('size-3.5', meta.tone)} />
        <div className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
          {status.label}
        </div>
        <div className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
          {items.length}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 py-2 scrollbar-sleek">
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
                  selectedWorktrees={
                    isSelected && selectedWorktrees.length > 0 ? selectedWorktrees : undefined
                  }
                  compact={compact}
                  onActivate={onActivate}
                  onSelectionGesture={onSelectionGesture}
                  onContextMenuSelect={onContextMenuSelect}
                />
              )
            })}
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
            Empty
          </div>
        )}
      </div>
    </section>
  )
}
