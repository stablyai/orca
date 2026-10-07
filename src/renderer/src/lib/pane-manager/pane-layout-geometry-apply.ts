import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { PaneManagerHost } from './pane-manager-host'
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

/** False when the DOM's tree differs from `node`, so a mismatch never applies partially. */
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
  // Why: a zoomed pane hides its siblings and owns their flex; collapse restores saved styles over any write.
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
  // Why: replay ignores an out-of-range ratio too (wrapInSplit), leaving an equal split.
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
  // Why: a divider binds its drag axis at creation, so an orientation flip needs a new one.
  disposeDivider(write.divider)
  split.replaceChild(createDivider(isVertical), write.divider)
}

/**
 * Applies split orientation and ratios from `layout` to the mounted pane tree
 * in place. Only applies when the DOM already holds exactly the layout's
 * leaves in the same tree shape, unzoomed; returns whether anything changed.
 */
export function applyPaneLayoutGeometry(
  host: PaneManagerHost,
  layout: TerminalPaneLayoutNode
): boolean {
  const top = host.root.firstElementChild
  if (!(top instanceof HTMLElement)) {
    return false
  }
  const writes: GeometryWrite[] = []
  if (!planGeometryWrites(layout, top, writes) || writes.length === 0) {
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
