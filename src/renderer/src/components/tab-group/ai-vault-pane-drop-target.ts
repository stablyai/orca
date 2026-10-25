import type { CSSProperties } from 'react'
import { resolveDropZone } from './tab-drop-zone'
import type { TabDropZone } from './useTabDragSplit'

export type PaneDropTarget = { groupId: string; zone: TabDropZone; overlayStyle: CSSProperties }

function getZoneOverlayStyle(rect: DOMRect, layerRect: DOMRect, zone: TabDropZone): CSSProperties {
  const left = rect.left - layerRect.left
  const top = rect.top - layerRect.top
  const width = rect.width
  const height = rect.height
  switch (zone) {
    case 'up':
      return { left, top, width, height: height / 2 }
    case 'down':
      return { left, top: top + height / 2, width, height: height / 2 }
    case 'left':
      return { left, top, width: width / 2, height }
    case 'right':
      return { left: left + width / 2, top, width: width / 2, height }
    case 'center':
      return { left, top, width, height }
  }
}

export function containsPoint(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

export function resolvePaneDropTarget(
  worktreeId: string,
  layerRect: DOMRect,
  point: { x: number; y: number }
): PaneDropTarget | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-tab-group-body-id][data-worktree-id]'
  )) {
    if (element.dataset.worktreeId !== worktreeId) {
      continue
    }
    const groupId = element.dataset.tabGroupBodyId
    const rect = element.getBoundingClientRect()
    if (!groupId || rect.width <= 0 || rect.height <= 0 || !containsPoint(rect, point.x, point.y)) {
      continue
    }
    const zone = resolveDropZone(rect, point)
    return { groupId, zone, overlayStyle: getZoneOverlayStyle(rect, layerRect, zone) }
  }
  return null
}
