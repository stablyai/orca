import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PaneSide } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { AppState } from '../../store/types'
import {
  isSourceWideRefusal,
  resolveTerminalTabIntoPaneEligibility,
  type TerminalTabIntoPaneRefusal,
  type TerminalTabIntoPaneState
} from '../terminal-pane/terminal-tab-into-pane-eligibility'
import type { TabDragItemData, TabDropZone } from './tab-drag-data'
import {
  escapeCssAttrValue,
  findTabGroupPanelUnderPointer,
  getTabGroupBodyRect,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'
import { paneColumnInteriorRect, resolveLeafDropZone, type PaneRect } from './tab-drop-zone'

export type LeafRect = { leafId: string; rect: PaneRect }

export type TabDragLeafTarget = {
  groupId: string
  targetTabId: string
  leafId: string
  zone: Exclude<TabDropZone, 'center'>
  side: PaneSide
  /** The visible leaf, clipped to its group body: the overlay is drawn on it. */
  leafRect: PaneRect
  /** Why a drop here would be refused; null when it would join. */
  refusal: TerminalTabIntoPaneRefusal | null
}

export type LeafTargetState = TerminalTabIntoPaneState &
  Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>

const SIDE_BY_ZONE: Record<Exclude<TabDropZone, 'center'>, PaneSide> = {
  left: 'left',
  right: 'right',
  up: 'top',
  down: 'bottom'
}

// Not about this leaf at all: the drag keeps today's behaviour and shows no leaf overlay.
const UNRELATED_REFUSALS: ReadonlySet<TerminalTabIntoPaneRefusal> = new Set([
  'same_tab',
  'target_missing',
  'worktree_mismatch',
  'host_authoritative'
])

/** Whether two targets name the same pane edge of the same shown tab. */
export function isSameJoinTarget(a: TabDragLeafTarget, b: TabDragLeafTarget | null): boolean {
  return (
    b !== null &&
    a.groupId === b.groupId &&
    a.targetTabId === b.targetTabId &&
    a.leafId === b.leafId &&
    a.zone === b.zone
  )
}

/** The mounted, visible panes of a terminal tab, in viewport coordinates. */
export function readMountedLeafRects(tabId: string): LeafRect[] {
  const roots = document.querySelectorAll<HTMLElement>(
    `[data-terminal-tab-id="${escapeCssAttrValue(tabId)}"]`
  )
  return Array.from(roots).flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')).flatMap((pane) => {
      const { leafId } = pane.dataset
      const rect = pane.getBoundingClientRect()
      if (!leafId || rect.width <= 0 || rect.height <= 0) {
        return []
      }
      const { left, top, width, height } = rect
      return [{ leafId, rect: { left, top, width, height } }]
    })
  )
}

function intersect(a: PaneRect, b: PaneRect): PaneRect | null {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)
  if (right <= left || bottom <= top) {
    return null
  }
  return { left, top, width: right - left, height: bottom - top }
}

function contains(rect: PaneRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  )
}

/**
 * The pane edge a dragged terminal tab is over, when dropping it would join it there. Null means
 * "not a leaf drop": the strip, the Level 1 band, a leaf's center, a source that cannot join, or a
 * shown tab that is not a terminal all keep today's behaviour. A target that cannot take the tab
 * is still returned, with its refusal, so the overlay can say why. Always null in a layout-owner build.
 */
export function resolveTabDragLeafTarget({
  activeDrag,
  pointer,
  worktreeId,
  state,
  geometry,
  readLeafRects = readMountedLeafRects
}: {
  activeDrag: TabDragItemData
  pointer: { x: number; y: number } | null
  worktreeId: string
  state: LeafTargetState
  geometry: TabGroupPanelGeometrySnapshot | null
  readLeafRects?: (tabId: string) => LeafRect[]
}): TabDragLeafTarget | null {
  // A layout-owner build draws every move from main's frames: no overlay, no window-applied join.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN ||
    !pointer ||
    activeDrag.tabType !== 'terminal' ||
    activeDrag.worktreeId !== worktreeId
  ) {
    return null
  }
  const panelHit = findTabGroupPanelUnderPointer(worktreeId, pointer, { geometry })
  if (!panelHit) {
    return null
  }
  const bodyRect =
    geometry?.byGroupId.get(panelHit.groupId)?.bodyRect ??
    getTabGroupBodyRect(panelHit.groupId, worktreeId)
  const interior = bodyRect ? paneColumnInteriorRect(panelHit.panelRect, { bodyRect }) : null
  if (!bodyRect || !interior || !contains(interior, pointer)) {
    return null
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === panelHit.groupId)
  // During a drag the group's active tab is the preview, which is what is on screen.
  const shown = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === group?.activeTabId && tab.groupId === panelHit.groupId
  )
  if (!shown || shown.contentType !== 'terminal' || shown.entityId === activeDrag.visibleTabId) {
    return null
  }
  const leaf = readLeafRects(shown.entityId)
    .flatMap(({ leafId, rect }) => {
      const visible = intersect(rect, bodyRect)
      return visible ? [{ leafId, rect: visible }] : []
    })
    .find(({ rect }) => contains(rect, pointer))
  const effective = leaf ? intersect(leaf.rect, interior) : null
  const zone = effective ? resolveLeafDropZone(effective, pointer) : null
  if (!leaf || !zone || zone === 'center') {
    return null
  }
  const eligibility = resolveTerminalTabIntoPaneEligibility(state, {
    sourceTabId: activeDrag.visibleTabId,
    targetTabId: shown.entityId,
    targetLeafId: leaf.leafId
  })
  if (
    !eligibility.ok &&
    (isSourceWideRefusal(eligibility.reason) || UNRELATED_REFUSALS.has(eligibility.reason))
  ) {
    return null
  }
  return {
    groupId: panelHit.groupId,
    targetTabId: shown.entityId,
    leafId: leaf.leafId,
    zone,
    side: SIDE_BY_ZONE[zone],
    leafRect: leaf.rect,
    refusal: eligibility.ok ? null : eligibility.reason
  }
}
