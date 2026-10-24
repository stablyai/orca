import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import {
  workspaceGridViewCellEdges,
  type WorkspaceGridViewCellRect
} from '@/lib/workspace-grid-view-cell-rects'
import { focusWorkspaceGridViewMember } from '@/lib/workspace-grid-view-actions'

/** Marks controls inside a cell that act on the grid view instead of focusing the cell. */
export const WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR = 'data-workspace-grid-view-cell-action'

export function workspaceGridViewCellStyle(rect: WorkspaceGridViewCellRect): CSSProperties {
  return {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`
  }
}

/** One hairline between neighbours: cells paint only their inner right and bottom seams. */
export function workspaceGridViewCellClassName(rect: WorkspaceGridViewCellRect): string {
  const edges = workspaceGridViewCellEdges(rect)
  return cn(
    'absolute flex pt-7',
    !edges.right && 'border-r border-border',
    !edges.bottom && 'border-b border-border'
  )
}

/** Which window corners the cell's header shares with the floating sidebar toggles and window controls. */
export function workspaceGridViewCellWindowCorners(rect: WorkspaceGridViewCellRect): {
  topLeft: boolean
  topRight: boolean
} {
  const edges = workspaceGridViewCellEdges(rect)
  return { topLeft: edges.top && edges.left, topRight: edges.top && edges.right }
}

function isCellAction(target: EventTarget): target is Element {
  return (
    target instanceof Element &&
    target.closest(`[${WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR}]`) !== null
  )
}

function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return false
  }
}

export function focusWorkspaceGridViewCellOnPointerDown(
  target: EventTarget,
  workspaceId: string
): void {
  if (isCellAction(target)) {
    return
  }
  focusWorkspaceGridViewMember(workspaceId)
}

/** Keeps the active workspace on the cell that holds DOM focus, so shortcuts never hit another cell. */
export function focusWorkspaceGridViewCellOnFocus(target: EventTarget, workspaceId: string): void {
  // Why: a click on a cell action also focuses it; only keyboard focus there moves the workspace.
  if (isCellAction(target) && !isKeyboardFocus(target)) {
    return
  }
  focusWorkspaceGridViewMember(workspaceId)
}
