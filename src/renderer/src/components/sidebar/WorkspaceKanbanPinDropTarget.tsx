import React from 'react'
import { Pin } from 'lucide-react'
import { cn } from '@/lib/utils'

type WorkspaceKanbanPinDropTargetProps = {
  isDragOver: boolean
  onDragOver: (event: React.DragEvent) => void
  onDragLeave: (event: React.DragEvent) => void
}

export default function WorkspaceKanbanPinDropTarget({
  isDragOver,
  onDragOver,
  onDragLeave
}: WorkspaceKanbanPinDropTargetProps): React.JSX.Element {
  return (
    <div
      data-workspace-pin-drop-target=""
      className={cn(
        'mb-3 flex h-8 shrink-0 items-center gap-2 rounded-md border border-dashed border-sidebar-border bg-background/45 px-3 text-[12px] text-muted-foreground transition-colors',
        isDragOver && 'border-sidebar-ring bg-sidebar-accent text-foreground'
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <Pin className="size-3.5" />
      <span className="font-medium">Pinned</span>
      <span className="truncate">Drop here to pin without changing status.</span>
    </div>
  )
}
