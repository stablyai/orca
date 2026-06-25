import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import { isPaneColumnSplitDropNoOp } from '../../store/slices/pane-column-split-drop-no-op'
import {
  resolvePaneColumnEdgeZone,
  TAB_GROUP_TAB_STRIP_HEIGHT_PX,
  type PaneColumnSplitTarget
} from './tab-drop-zone'
import {
  canDropTabIntoPaneBody,
  isPaneDropData,
  isTabDragData,
  type TabDragItemData
} from './useTabDragSplit'

export type TabGroupPanelGeometryEntry = {
  groupId: string
  panelRect: DOMRect
  bodyRect: DOMRect
}

export type TabGroupPanelGeometrySnapshot = {
  entries: TabGroupPanelGeometryEntry[]
  byGroupId: Map<string, TabGroupPanelGeometryEntry>
}

export type ActivePaneColumnSplitTarget = PaneColumnSplitTarget & {
  panelRect?: DOMRect
}

function escapeCssAttrValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getTabGroupBodyElement(groupId: string, worktreeId: string): HTMLElement | null {
  const escapedGroupId = escapeCssAttrValue(groupId)
  const escapedWorktreeId = escapeCssAttrValue(worktreeId)
  return document.querySelector<HTMLElement>(
    `[data-tab-group-body-id="${escapedGroupId}"][data-worktree-id="${escapedWorktreeId}"]`
  )
}

export function getTabGroupPanelRect(groupId: string, worktreeId: string): DOMRect | null {
  return getTabGroupBodyElement(groupId, worktreeId)?.parentElement?.getBoundingClientRect() ?? null
}

export function getTabGroupBodyRect(groupId: string, worktreeId: string): DOMRect | null {
  return getTabGroupBodyElement(groupId, worktreeId)?.getBoundingClientRect() ?? null
}

export function captureTabGroupPanelGeometrySnapshot(
  worktreeId: string
): TabGroupPanelGeometrySnapshot {
  const escapedWorktreeId = escapeCssAttrValue(worktreeId)
  const bodies = document.querySelectorAll<HTMLElement>(
    `[data-tab-group-body-id][data-worktree-id="${escapedWorktreeId}"]`
  )
  const entries: TabGroupPanelGeometryEntry[] = []
  for (const body of bodies) {
    const groupId = body.dataset.tabGroupBodyId
    const panelElement = body.parentElement
    if (!groupId || !panelElement) {
      continue
    }
    entries.push({
      groupId,
      panelRect: panelElement.getBoundingClientRect(),
      bodyRect: body.getBoundingClientRect()
    })
  }

  return {
    entries,
    byGroupId: new Map(entries.map((entry) => [entry.groupId, entry]))
  }
}

export function findTabGroupPanelUnderPointer(
  worktreeId: string,
  pointer: { x: number; y: number },
  options: {
    geometry?: TabGroupPanelGeometrySnapshot | null
    getPanelRect?: (groupId: string, worktreeId: string) => DOMRect | null
  } = {}
): { groupId: string; panelRect: DOMRect } | null {
  if (options.geometry) {
    for (const entry of options.geometry.entries) {
      const { panelRect } = entry
      if (
        pointer.x >= panelRect.left &&
        pointer.x <= panelRect.right &&
        pointer.y >= panelRect.top &&
        pointer.y <= panelRect.bottom
      ) {
        return { groupId: entry.groupId, panelRect }
      }
    }
    return null
  }

  const getPanelRect = options.getPanelRect ?? getTabGroupPanelRect
  const escapedWorktreeId = escapeCssAttrValue(worktreeId)
  const bodies = document.querySelectorAll<HTMLElement>(
    `[data-tab-group-body-id][data-worktree-id="${escapedWorktreeId}"]`
  )
  for (const body of bodies) {
    const groupId = body.dataset.tabGroupBodyId
    if (!groupId) {
      continue
    }
    const panelRect = getPanelRect(groupId, worktreeId)
    if (!panelRect) {
      continue
    }
    if (
      pointer.x >= panelRect.left &&
      pointer.x <= panelRect.right &&
      pointer.y >= panelRect.top &&
      pointer.y <= panelRect.bottom
    ) {
      return { groupId, panelRect }
    }
  }
  return null
}

export function resolvePanelEdgePaneColumnSplit({
  activeDrag,
  targetGroupId,
  worktreeId,
  pointer,
  groupsByWorktree,
  layoutByWorktree,
  panelRect: providedPanelRect,
  bodyRect: providedBodyRect
}: {
  activeDrag: TabDragItemData
  targetGroupId: string
  worktreeId: string
  pointer: { x: number; y: number }
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  panelRect?: DOMRect | null
  bodyRect?: DOMRect | null
}): PaneColumnSplitTarget | null {
  const panelRect = providedPanelRect ?? getTabGroupPanelRect(targetGroupId, worktreeId)
  if (!panelRect) {
    return null
  }
  // Why: dnd-kit can keep a closest-center `over` target after the pointer
  // leaves the pane; edge splits must only resolve inside the actual panel.
  if (
    pointer.x < panelRect.left ||
    pointer.x > panelRect.left + panelRect.width ||
    pointer.y < panelRect.top ||
    pointer.y > panelRect.top + panelRect.height
  ) {
    return null
  }

  const bodyRect = providedBodyRect ?? getTabGroupBodyRect(targetGroupId, worktreeId)

  const zone = resolvePaneColumnEdgeZone(panelRect, pointer, {
    bodyRect: bodyRect ?? null,
    tabStripHeightPx: TAB_GROUP_TAB_STRIP_HEIGHT_PX
  })
  if (!zone) {
    return null
  }

  const sourceGroup = (groupsByWorktree[worktreeId] ?? []).find(
    (group) => group.id === activeDrag.groupId
  )
  if (
    isPaneColumnSplitDropNoOp({
      sourceGroupId: activeDrag.groupId,
      targetGroupId,
      splitDirection: zone,
      sourceTabCount: sourceGroup?.tabOrder.length ?? 0,
      layout: layoutByWorktree[worktreeId]
    })
  ) {
    return null
  }

  if (activeDrag.groupId === targetGroupId) {
    if (
      !canDropTabIntoPaneBody({
        activeDrag,
        groupsByWorktree,
        overGroupId: targetGroupId,
        worktreeId
      })
    ) {
      return null
    }
  }

  return { groupId: targetGroupId, zone }
}

export function resolveActivePaneColumnSplitTarget({
  event,
  groupsByWorktree,
  layoutByWorktree,
  worktreeId,
  getDragPointer,
  geometry
}: {
  event: DragMoveEvent | DragOverEvent | DragEndEvent
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  worktreeId: string
  getDragPointer: (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
    x: number
    y: number
  } | null
  geometry?: TabGroupPanelGeometrySnapshot | null
}): ActivePaneColumnSplitTarget | null {
  const activeData = event.active.data.current
  const pointer = getDragPointer(event)
  if (!isTabDragData(activeData) || !pointer) {
    return null
  }

  const overData = event.over?.data.current
  const panelHit = findTabGroupPanelUnderPointer(worktreeId, pointer, { geometry })

  if (isTabDragData(overData)) {
    // Why: tab-strip drags target reorder/insertion slots. Split creation stays
    // on pane/body edges so hovering over a tab never surprises the user with a
    // new split.
    if (!panelHit || pointer.y < panelHit.panelRect.top + TAB_GROUP_TAB_STRIP_HEIGHT_PX) {
      return null
    }
  }

  const targetGroupId =
    panelHit?.groupId ??
    (isTabDragData(overData) ? overData.groupId : null) ??
    (isPaneDropData(overData) ? overData.groupId : null)

  if (!targetGroupId) {
    return null
  }

  const targetGeometry = geometry?.byGroupId.get(targetGroupId)
  const panelRect =
    panelHit?.groupId === targetGroupId ? panelHit.panelRect : targetGeometry?.panelRect
  const splitTarget = resolvePanelEdgePaneColumnSplit({
    activeDrag: activeData,
    targetGroupId,
    worktreeId,
    pointer,
    groupsByWorktree,
    layoutByWorktree,
    panelRect,
    bodyRect: targetGeometry?.bodyRect
  })
  return splitTarget ? { ...splitTarget, panelRect } : null
}
