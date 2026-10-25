import type { KeybindingActionId } from '../keybindings/types'
import type { TabGroupLayoutNode } from '../tab-types'

export type TabGroupFocusDirection = 'left' | 'right' | 'up' | 'down'

const TAB_GROUP_FOCUS_ACTION_IDS: Readonly<Record<TabGroupFocusDirection, KeybindingActionId>> = {
  left: 'tab.focusGroupLeft',
  down: 'tab.focusGroupDown',
  up: 'tab.focusGroupUp',
  right: 'tab.focusGroupRight'
}

const TAB_GROUP_FOCUS_DIRECTIONS: readonly TabGroupFocusDirection[] = [
  'left',
  'down',
  'up',
  'right'
]

export function tabGroupFocusActionId(direction: TabGroupFocusDirection): KeybindingActionId {
  return TAB_GROUP_FOCUS_ACTION_IDS[direction]
}

/** The direction whose focus-group shortcut `matches` accepts, if any. */
export function matchTabGroupFocusDirection(
  matches: (actionId: KeybindingActionId) => boolean
): TabGroupFocusDirection | null {
  return (
    TAB_GROUP_FOCUS_DIRECTIONS.find((direction) =>
      matches(TAB_GROUP_FOCUS_ACTION_IDS[direction])
    ) ?? null
  )
}

type GroupRect = { left: number; top: number; right: number; bottom: number }

const EPSILON = 1e-6

/** Lays the tree out in a unit square, in visual order (first child before second). */
function collectGroupRects(
  node: TabGroupLayoutNode,
  rect: GroupRect,
  out: Map<string, GroupRect>
): void {
  if (node.type === 'leaf') {
    out.set(node.groupId, rect)
    return
  }
  const ratio = node.ratio ?? 0.5
  // 'horizontal' places children side by side, 'vertical' stacks them.
  if (node.direction === 'horizontal') {
    const split = rect.left + (rect.right - rect.left) * ratio
    collectGroupRects(node.first, { ...rect, right: split }, out)
    collectGroupRects(node.second, { ...rect, left: split }, out)
    return
  }
  const split = rect.top + (rect.bottom - rect.top) * ratio
  collectGroupRects(node.first, { ...rect, bottom: split }, out)
  collectGroupRects(node.second, { ...rect, top: split }, out)
}

function sharedEdgeLength(
  from: GroupRect,
  to: GroupRect,
  direction: TabGroupFocusDirection
): number {
  const touches =
    direction === 'left'
      ? Math.abs(to.right - from.left) < EPSILON
      : direction === 'right'
        ? Math.abs(to.left - from.right) < EPSILON
        : direction === 'up'
          ? Math.abs(to.bottom - from.top) < EPSILON
          : Math.abs(to.top - from.bottom) < EPSILON
  if (!touches) {
    return 0
  }
  return direction === 'left' || direction === 'right'
    ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
    : Math.min(from.right, to.right) - Math.max(from.left, to.left)
}

/**
 * The group that shares the longest edge with `groupId` on `direction`, or null at the layout edge.
 * Ties go to the higher `recency`, then to the first group in visual order.
 */
export function findTabGroupNeighbor(
  root: TabGroupLayoutNode,
  groupId: string,
  direction: TabGroupFocusDirection,
  recency: (groupId: string) => number = () => 0
): string | null {
  const rects = new Map<string, GroupRect>()
  collectGroupRects(root, { left: 0, top: 0, right: 1, bottom: 1 }, rects)
  const from = rects.get(groupId)
  if (!from) {
    return null
  }
  let best: { groupId: string; overlap: number; recency: number } | null = null
  for (const [candidateId, rect] of rects) {
    if (candidateId === groupId) {
      continue
    }
    const overlap = sharedEdgeLength(from, rect, direction)
    if (overlap <= EPSILON) {
      continue
    }
    const candidate = { groupId: candidateId, overlap, recency: recency(candidateId) }
    if (
      !best ||
      overlap > best.overlap + EPSILON ||
      (Math.abs(overlap - best.overlap) <= EPSILON && candidate.recency > best.recency)
    ) {
      best = candidate
    }
  }
  return best?.groupId ?? null
}
