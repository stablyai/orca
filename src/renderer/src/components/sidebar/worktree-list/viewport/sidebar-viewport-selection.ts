import {
  retainSidebarAncestors,
  sidebarSlotContentEnd,
  sidebarViewportNodes,
  type SidebarGeometry
} from '../listing/sidebar-geometry-slots'
import type { RenderRow } from '../listing/render-row'
import { extractWorktreeVirtualRowIndexes } from './virtual-rows'
import { clampSidebarOffset } from './sidebar-geometry-commit'
import { getScrollTopToRevealBounds } from '../../worktree-sidebar-reveal'

export function selectSidebarViewport(args: {
  model: SidebarGeometry
  boundaries: readonly number[]
  rows: RenderRow[]
  offset: number
  target: number
  viewport: number
  inset: number
  targets: readonly { index: number; landing: boolean }[]
  stickyHeaderIndexes: number[]
  rootByOuterIndex: ReadonlyMap<number, number>
}) {
  const { model, boundaries, offset, target, viewport, inset } = args
  const retained = new Set<number>()
  for (const top of new Set([
    offset,
    clampSidebarOffset(target, boundaries.at(-1)!, viewport, inset),
    clampSidebarOffset(offset, boundaries.at(-1)!, viewport, inset)
  ])) {
    for (const index of sidebarViewportNodes(
      model,
      boundaries,
      Math.max(0, top - inset),
      viewport
    )) {
      retained.add(index)
    }
  }
  for (const { index, landing } of args.targets) {
    retained.add(index)
    if (landing) {
      const node = model.nodes[index]!
      const landingOffset =
        getScrollTopToRevealBounds(
          { scrollTop: offset, clientHeight: viewport },
          {
            start: boundaries[node.slot]! + inset,
            end: sidebarSlotContentEnd(model, boundaries, node.end - 1) + inset
          },
          node.revealTopInset
        ) ?? offset
      for (const child of sidebarViewportNodes(
        model,
        boundaries,
        Math.max(0, clampSidebarOffset(landingOffset, boundaries.at(-1)!, viewport, inset) - inset),
        viewport
      )) {
        retained.add(child)
      }
    }
  }
  const firstNode = sidebarViewportNodes(
    model,
    boundaries,
    Math.max(0, target - inset),
    viewport,
    0
  )[0]
  const outerStart = firstNode === undefined ? 0 : model.nodes[firstNode]!.outerIndex
  const sticky = extractWorktreeVirtualRowIndexes({
    range: { startIndex: outerStart, endIndex: outerStart, overscan: 0, count: args.rows.length },
    stickyHeaderIndexes: args.stickyHeaderIndexes,
    rows: args.rows
  })
  for (const outerIndex of sticky) {
    const root = args.rootByOuterIndex.get(outerIndex)
    if (root !== undefined) {
      retained.add(root)
    }
  }
  const selected = retainSidebarAncestors(model, retained)
  const slots = [...selected]
    .flatMap((index) => {
      const node = model.nodes[index]!
      return node.close === null ? [node.slot] : [node.slot, node.close]
    })
    .sort((a, b) => a - b)
  return { selected, slots, outerStart }
}
