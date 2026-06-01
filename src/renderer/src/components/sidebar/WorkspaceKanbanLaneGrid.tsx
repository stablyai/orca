import React from 'react'
import type {
  Repo,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

type WorkspaceKanbanLaneGridProps = {
  statuses: readonly WorkspaceStatusDefinition[]
  worktreesByStatus: ReadonlyMap<WorkspaceStatus, readonly Worktree[]>
  repoMap: Map<string, Repo>
  activeWorktreeId: string | null
  columnWidth: number
  isResizingColumn: boolean
  dragOverStatus: WorkspaceStatus | null
  canCreateWorktree: boolean
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

export default function WorkspaceKanbanLaneGrid({
  statuses,
  worktreesByStatus,
  repoMap,
  activeWorktreeId,
  columnWidth,
  isResizingColumn,
  dragOverStatus,
  canCreateWorktree,
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
}: WorkspaceKanbanLaneGridProps): React.JSX.Element {
  return (
    <div
      className="grid h-full min-h-0 min-w-full grid-rows-[minmax(0,1fr)] gap-3"
      style={{
        gridTemplateColumns: `repeat(${statuses.length}, minmax(${columnWidth}px, ${columnWidth}px))`
      }}
    >
      {statuses.map((status) => (
        <WorkspaceKanbanStatusLane
          key={status.id}
          status={status}
          items={worktreesByStatus.get(status.id) ?? []}
          repoMap={repoMap}
          activeWorktreeId={activeWorktreeId}
          columnWidth={columnWidth}
          isResizingColumn={isResizingColumn}
          isDragTarget={dragOverStatus === status.id}
          canCreateWorktree={canCreateWorktree}
          selectedWorktreeIds={selectedWorktreeIds}
          selectedWorktrees={selectedWorktrees}
          nativeDragEnabled={false}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onActivate={onActivate}
          onSelectionGesture={onSelectionGesture}
          onContextMenuSelect={onContextMenuSelect}
          onCreateWorktree={onCreateWorktree}
          onColumnResizeStart={onColumnResizeStart}
          onColumnResizeKeyDown={onColumnResizeKeyDown}
        />
      ))}
    </div>
  )
}
