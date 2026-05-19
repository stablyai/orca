import React from 'react'

type WorkspaceKanbanAreaSelectionOverlayProps = React.HTMLAttributes<HTMLDivElement>

const WorkspaceKanbanAreaSelectionOverlay = React.forwardRef<
  HTMLDivElement,
  WorkspaceKanbanAreaSelectionOverlayProps
>(function WorkspaceKanbanAreaSelectionOverlay(props, ref): React.JSX.Element {
  return (
    <div
      {...props}
      ref={ref}
      data-workspace-board-selection-rect=""
      className="pointer-events-none absolute left-0 top-0 z-30 hidden rounded-md border border-sidebar-ring bg-sidebar-ring/15 will-change-transform"
    />
  )
})

export default WorkspaceKanbanAreaSelectionOverlay
