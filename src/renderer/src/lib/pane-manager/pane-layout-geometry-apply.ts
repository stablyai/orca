import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PaneManagerHost } from './pane-manager-host'
import { movePanesToMatchTree } from './pane-tree-match-moves'
import { applyDividerStyles, disposeDivider } from './pane-divider'
import { findPaneChildren } from './pane-tree-equalization'
import { refitPanesUnder } from './pane-tree-ops'
import { readSplitRatio, SPLIT_RATIO_TOLERANCE } from './pane-split-ratio'

export type { TerminalPaneLayoutNode }

type GeometryWrite = {
  split: HTMLElement
  first: HTMLElement
  second: HTMLElement
  divider: HTMLElement
  isVertical: boolean
  ratio: number
  flipOrientation: boolean
  writeRatio: boolean
}

function findDividers(split: HTMLElement): HTMLElement[] {
  return Array.from(split.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )
}

/** Reject mismatched DOM trees before applying any geometry. */
function planGeometryWrites(
  node: TerminalPaneLayoutNode,
  el: HTMLElement,
  writes: GeometryWrite[]
): boolean {
  if (node.type === 'leaf') {
    return el.classList.contains('pane') && el.dataset.leafId === node.leafId
  }
  if (!el.classList.contains('pane-split')) {
    return false
  }
  const [first, second, extra] = findPaneChildren(el)
  const [divider, extraDivider] = findDividers(el)
  if (!first || !second || extra || !divider || extraDivider) {
    return false
  }
  // Zoom owns sibling visibility/flex; collapse would overwrite geometry applied while zoomed.
  if (first.style.display === 'none' || second.style.display === 'none') {
    return false
  }
  if (!planGeometryWrites(node.first, first, writes)) {
    return false
  }
  if (!planGeometryWrites(node.second, second, writes)) {
    return false
  }
  const isVertical = node.direction === 'vertical'
  const flipOrientation = el.classList.contains('is-vertical') !== isVertical
  // Match replay’s wrapInSplit fallback to equal halves for invalid ratios.
  const ratio = node.ratio !== undefined && node.ratio > 0 && node.ratio < 1 ? node.ratio : 0.5
  const writeRatio = Math.abs(readSplitRatio(first, second) - ratio) > SPLIT_RATIO_TOLERANCE
  if (flipOrientation || writeRatio) {
    writes.push({
      split: el,
      first,
      second,
      divider,
      isVertical,
      ratio,
      flipOrientation,
      writeRatio
    })
  }
  return true
}

function flipSplitOrientation(
  write: GeometryWrite,
  createDivider: (isVertical: boolean) => HTMLElement
): void {
  const { split, isVertical } = write
  split.classList.toggle('is-vertical', isVertical)
  split.classList.toggle('is-horizontal', !isVertical)
  split.style.flexDirection = isVertical ? 'row' : 'column'
  // Orientation changes need a new divider because its drag axis is bound at creation.
  disposeDivider(write.divider)
  split.replaceChild(createDivider(isVertical), write.divider)
}

/** Apply host orientation/ratios without replacing terminals. Require matching leaves/tree and no zoom; followFrameTree first reshapes the same leaves. Return whether geometry changed. */
export function applyPaneLayoutGeometry(
  host: PaneManagerHost,
  layout: TerminalPaneLayoutNode,
  followFrameTree = false
): boolean {
  const top = host.root.firstElementChild
  if (!(top instanceof HTMLElement)) {
    return false
  }
  const writes: GeometryWrite[] = []
  if (!planGeometryWrites(layout, top, writes)) {
    if (followFrameTree && movePanesToMatchTree(host, layout)) {
      applyPaneLayoutGeometry(host, layout)
      return true
    }
    return false
  }
  if (writes.length === 0) {
    return false
  }
  for (const write of writes) {
    if (write.flipOrientation) {
      flipSplitOrientation(write, host.createDivider)
    }
    if (write.writeRatio) {
      write.first.style.flex = `${write.ratio} 1 0%`
      write.second.style.flex = `${1 - write.ratio} 1 0%`
    }
  }
  applyDividerStyles(host.root, host.getStyleOptions())
  for (const write of writes) {
    refitPanesUnder(write.split, host.panes)
  }
  return true
}
