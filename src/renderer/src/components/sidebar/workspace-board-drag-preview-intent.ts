const WORKSPACE_BOARD_DRAG_PREVIEW_EDGE_ZONE_PX = 48
const WORKSPACE_BOARD_DRAG_PREVIEW_MIN_RIGHTWARD_PX = 16

export function shouldStartWorkspaceBoardDragPreview(args: {
  pointerX: number
  startX: number
  sidebarRight: number
}): boolean {
  return (
    args.pointerX >= args.sidebarRight - WORKSPACE_BOARD_DRAG_PREVIEW_EDGE_ZONE_PX &&
    args.pointerX - args.startX >= WORKSPACE_BOARD_DRAG_PREVIEW_MIN_RIGHTWARD_PX
  )
}
