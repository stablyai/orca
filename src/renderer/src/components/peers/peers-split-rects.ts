import {
  leafKey,
  type PeersLayoutNode,
  type PeersLayoutPathSegment,
  type PeersPaneLeaf
} from './peers-split-tree'

export type PeersLayoutRect = { x: number; y: number; width: number; height: number }

export type PeersLayoutPane = {
  key: string
  target: PeersPaneLeaf
  rect: PeersLayoutRect
}

export type PeersLayoutDivider = {
  path: PeersLayoutPathSegment[]
  direction: 'row' | 'column'
  rect: PeersLayoutRect
}

export type PeersLayoutRects = {
  panes: PeersLayoutPane[]
  dividers: PeersLayoutDivider[]
}

const DIVIDER_THICKNESS_PX = 6

type SplitBoxes = {
  firstBox: PeersLayoutRect
  secondBox: PeersLayoutRect
  dividerRect: PeersLayoutRect
}

/** Divides `box` into first/second sub-boxes plus the divider rect between them, per split direction and ratio — the single source of the box-subdivision math shared by every tree walker below. */
function splitBox(box: PeersLayoutRect, direction: 'row' | 'column', ratio: number): SplitBoxes {
  if (direction === 'row') {
    const firstWidth = (box.width - DIVIDER_THICKNESS_PX) * ratio
    const secondX = box.x + firstWidth + DIVIDER_THICKNESS_PX
    return {
      firstBox: { x: box.x, y: box.y, width: firstWidth, height: box.height },
      secondBox: { x: secondX, y: box.y, width: box.x + box.width - secondX, height: box.height },
      dividerRect: {
        x: box.x + firstWidth,
        y: box.y,
        width: DIVIDER_THICKNESS_PX,
        height: box.height
      }
    }
  }
  const firstHeight = (box.height - DIVIDER_THICKNESS_PX) * ratio
  const secondY = box.y + firstHeight + DIVIDER_THICKNESS_PX
  return {
    firstBox: { x: box.x, y: box.y, width: box.width, height: firstHeight },
    secondBox: { x: box.x, y: secondY, width: box.width, height: box.y + box.height - secondY },
    dividerRect: {
      x: box.x,
      y: box.y + firstHeight,
      width: box.width,
      height: DIVIDER_THICKNESS_PX
    }
  }
}

function walk(
  node: PeersLayoutNode,
  box: PeersLayoutRect,
  path: PeersLayoutPathSegment[],
  panes: PeersLayoutPane[],
  dividers: PeersLayoutDivider[]
): void {
  if (node.type === 'leaf') {
    panes.push({ key: leafKey(node.target), target: node.target, rect: box })
    return
  }
  const { firstBox, secondBox, dividerRect } = splitBox(box, node.direction, node.ratio ?? 0.5)
  dividers.push({ path, direction: node.direction, rect: dividerRect })
  walk(node.first, firstBox, [...path, 'first'], panes, dividers)
  walk(node.second, secondBox, [...path, 'second'], panes, dividers)
}

/** Recursively divides `box` by each split's ratio; dividers sit centered on the boundary at 6px thickness. */
export function computePeersLayoutRects(
  node: PeersLayoutNode,
  box: { width: number; height: number }
): PeersLayoutRects {
  const panes: PeersLayoutPane[] = []
  const dividers: PeersLayoutDivider[] = []
  walk(node, { x: 0, y: 0, width: box.width, height: box.height }, [], panes, dividers)
  return { panes, dividers }
}

function walkToPath(
  node: PeersLayoutNode,
  box: PeersLayoutRect,
  path: readonly PeersLayoutPathSegment[]
): PeersLayoutRect | null {
  if (path.length === 0) {
    return box
  }
  if (node.type !== 'split') {
    return null
  }
  const [segment, ...rest] = path
  const { firstBox, secondBox } = splitBox(box, node.direction, node.ratio ?? 0.5)
  return segment === 'first'
    ? walkToPath(node.first, firstBox, rest)
    : walkToPath(node.second, secondBox, rest)
}

/** Pixel box of the split node at `path`, before its own ratio subdivides it — the frame a divider drag measures its ratio against. */
export function findSplitBoxAtPath(
  node: PeersLayoutNode,
  box: { width: number; height: number },
  path: readonly PeersLayoutPathSegment[]
): PeersLayoutRect | null {
  return walkToPath(node, { x: 0, y: 0, width: box.width, height: box.height }, path)
}

/** Converts a container-relative pointer position into the 0-1 ratio for a divider's split box. */
export function ratioFromPointerInSplitBox(
  box: PeersLayoutRect,
  direction: 'row' | 'column',
  pointer: { x: number; y: number }
): number {
  return direction === 'row' ? (pointer.x - box.x) / box.width : (pointer.y - box.y) / box.height
}
