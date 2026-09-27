import { WORKTREE_SIDEBAR_REVEAL_TOP_INSET } from '../../worktree-sidebar-reveal'
import { getFolderRowKey } from './folder-row-identity'
import type { SidebarCardGeometryResolver, SidebarCardDimensions } from './sidebar-card-geometry'
import { buildLineageVirtualTree, LINEAGE_SIBLING_GAP } from './lineage-virtual-tree'
import { getRenderRowKey, type RenderRow } from './render-row'
import type { WorktreeItemRow } from './renderable-rows'
import {
  estimateRenderRowSize,
  HOST_STICKY_PINNED_HEIGHT,
  WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP
} from '../viewport/virtual-rows'

export type SidebarGeometryNode = {
  key: string
  row: RenderRow
  outerIndex: number
  parent: number | null
  children: number[]
  slot: number
  close: number | null
  end: number
  gap: number
  revealTopInset: number
  cardGeometry?: SidebarCardDimensions | null
}
export type SidebarGeometrySlot = {
  key: string
  node: number
  kind: 'row' | 'prefix' | 'closing'
  estimate: number
  geometryContext?: string
}
export type SidebarGeometry = {
  nodes: SidebarGeometryNode[]
  roots: number[]
  slots: SidebarGeometrySlot[]
  nodeByKey: ReadonlyMap<string, number>
  nodeByRowKey: ReadonlyMap<string, number>
}

// Semantic rows and numeric slots deliberately have separate indexes.
export function buildSidebarGeometry(
  rows: readonly RenderRow[],
  resolveCardGeometry?: SidebarCardGeometryResolver
): SidebarGeometry {
  const nodes: SidebarGeometryNode[] = []
  const roots: number[] = []
  const slots: SidebarGeometrySlot[] = []
  const nodeByKey = new Map<string, number>()
  const nodeByRowKey = new Map<string, number>()
  const firstHeader = rows.findIndex((row) => row.type === 'header' || row.type === 'host-header')
  let hostSection = 'local'
  let hasHostHeader = false
  const appendNode = (row: RenderRow, outerIndex: number, parent: number | null, gap: number) => {
    const index = nodes.length
    const key =
      row.type === 'folder-workspace'
        ? `folder-workspace:${hostSection}:${getFolderRowKey(row)}`
        : getRenderRowKey(row)
    nodes.push({
      key,
      row,
      outerIndex,
      parent,
      children: [],
      slot: -1,
      close: null,
      end: -1,
      gap,
      revealTopInset:
        WORKTREE_SIDEBAR_REVEAL_TOP_INSET +
        (hasHostHeader && row.type !== 'host-header' ? HOST_STICKY_PINNED_HEIGHT : 0)
    })
    nodeByKey.set(key, index)
    if (row.type === 'item') {
      nodeByRowKey.set(row.rowKey, index)
    }
    if (parent === null) {
      roots.push(index)
    } else {
      nodes[parent]!.children.push(index)
    }
    return index
  }
  for (const [outerIndex, row] of rows.entries()) {
    if (row.type === 'host-header') {
      hostSection = row.hostId
      hasHostHeader = true
    }
    const gap = outerIndex < rows.length - 1 ? WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP : 0
    if (row.type !== 'lineage-group') {
      appendNode(row, outerIndex, null, gap)
      continue
    }
    const tree = buildLineageVirtualTree(row.rows)
    const base = nodes.length
    for (const node of tree.nodes) {
      appendNode(
        node.row,
        outerIndex,
        node.parentIndex === null ? null : base + node.parentIndex,
        node.parentIndex === null ? gap : node.followingSibling ? LINEAGE_SIBLING_GAP : 0
      )
    }
  }
  const stack: { index: number; closing: boolean }[] = roots
    .toReversed()
    .map((index) => ({ index, closing: false }))
  while (stack.length) {
    const { index, closing } = stack.pop()!
    const node = nodes[index]!
    if (closing) {
      node.close = slots.length
      slots.push({
        key: `${node.key}:closing`,
        node: index,
        kind: 'closing',
        estimate: (node.cardGeometry?.closing ?? 0) + node.gap,
        geometryContext: node.cardGeometry?.fingerprint ?? ''
      })
      node.end = slots.length
      continue
    }
    node.slot = slots.length
    const expanded = node.children.length > 0
    node.cardGeometry =
      node.row.type === 'item' ? resolveCardGeometry?.(node.row, expanded) : undefined
    const estimate = node.cardGeometry
      ? expanded
        ? node.cardGeometry.prefix
        : node.cardGeometry.own
      : node.parent !== null || expanded
        ? 96
        : estimateRenderRowSize(rows, node.outerIndex, firstHeader, null)
    slots.push({
      key: `${node.key}:${expanded ? 'prefix' : 'row'}`,
      node: index,
      kind: expanded ? 'prefix' : 'row',
      geometryContext: node.cardGeometry?.fingerprint ?? '',
      estimate: estimate + (expanded ? 0 : node.gap)
    })
    if (expanded) {
      stack.push({ index, closing: true })
      for (const child of node.children.toReversed()) {
        stack.push({ index: child, closing: false })
      }
    } else {
      node.end = slots.length
    }
  }
  return { nodes, roots, slots, nodeByKey, nodeByRowKey }
}

export function sidebarGeometryBoundaries(
  model: SidebarGeometry,
  sizes: ReadonlyMap<string, number>
): number[] {
  const boundaries = [0]
  for (const slot of model.slots) {
    boundaries.push(boundaries.at(-1)! + (sizes.get(slot.key) ?? slot.estimate))
  }
  return boundaries
}

export function sidebarSlotContentEnd(
  model: SidebarGeometry,
  boundaries: readonly number[],
  index: number
): number {
  const node = model.nodes[model.slots[index]!.node]!
  return boundaries[index + 1]! - (index === node.end - 1 ? node.gap : 0)
}

export function retainSidebarAncestors(
  model: SidebarGeometry,
  indexes: Iterable<number>
): Set<number> {
  const retained = new Set<number>()
  for (let index of indexes) {
    while (model.nodes[index] && !retained.has(index)) {
      retained.add(index)
      const parent = model.nodes[index]!.parent
      if (parent === null) {
        break
      }
      index = parent
    }
  }
  return retained
}

// Overscan counts cards, including when a viewport intersects only closing chrome.
export function sidebarViewportNodes(
  model: SidebarGeometry,
  boundaries: readonly number[],
  offset: number,
  height: number,
  overscan = 10
): number[] {
  const selected = new Set<number>()
  let low = 0
  let high = model.slots.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (boundaries[middle + 1]! <= offset) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const start = low
  let end = start
  while (end < model.slots.length && boundaries[end]! < offset + height) {
    selected.add(model.slots[end++]!.node)
  }
  for (let slot = start - 1, cards = 0; slot >= 0 && cards < overscan; slot--) {
    if (model.slots[slot]!.kind !== 'closing') {
      selected.add(model.slots[slot]!.node)
      cards++
    }
  }
  for (let slot = end, cards = 0; slot < model.slots.length && cards < overscan; slot++) {
    if (model.slots[slot]!.kind !== 'closing') {
      selected.add(model.slots[slot]!.node)
      cards++
    }
  }
  return [...selected]
}

export type SidebarChildSpan =
  | { type: 'row'; node: number }
  | { type: 'spacer'; key: string; height: number }
export function sidebarChildSpans(
  model: SidebarGeometry,
  children: readonly number[],
  retained: ReadonlySet<number>,
  boundaries: readonly number[]
): SidebarChildSpan[] {
  const spans: SidebarChildSpan[] = []
  let cursor = 0
  while (cursor < children.length) {
    const first = children[cursor]!
    if (retained.has(first)) {
      spans.push({ type: 'row', node: first })
      cursor++
      continue
    }
    let last = first
    while (cursor < children.length && !retained.has(children[cursor]!)) {
      last = children[cursor++]!
    }
    const start = model.nodes[first]!
    const end = model.nodes[last]!
    spans.push({
      type: 'spacer',
      key: start.key,
      height: boundaries[end.end]! - boundaries[start.slot]! - end.gap
    })
  }
  return spans
}

export function sidebarNodeItem(node: SidebarGeometryNode): WorktreeItemRow | null {
  return node.row.type === 'item' ? node.row : null
}
