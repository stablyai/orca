import type { TabGroupLayoutNode } from '../../../../shared/workspace-layout/tab-groups/tab-types'

/**
 * Where attached tab rows begin along a vertical seam's right side, as fractions of the seam's height:
 * one per group in `second` whose left edge lies on the seam. Nested 1px seams are ignored.
 */
export function getSeamTabRowStarts(second: TabGroupLayoutNode): number[] {
  const starts: number[] = []
  const visit = (node: TabGroupLayoutNode, top: number, height: number): void => {
    if (node.type === 'leaf') {
      starts.push(top)
      return
    }
    const ratio = node.ratio ?? 0.5
    if (node.direction === 'horizontal') {
      // Side by side: only the first child reaches the left edge.
      visit(node.first, top, height)
      return
    }
    visit(node.first, top, height * ratio)
    visit(node.second, top + height * ratio, height * (1 - ratio))
  }
  visit(second, 0, 1)
  return starts
}
