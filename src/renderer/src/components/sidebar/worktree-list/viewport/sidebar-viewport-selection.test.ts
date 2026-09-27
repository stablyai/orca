import { describe, expect, it } from 'vitest'
import {
  buildSidebarGeometry,
  sidebarGeometryBoundaries,
  sidebarViewportNodes,
  retainSidebarAncestors
} from '../listing/sidebar-geometry-slots'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import type { RenderRow } from '../listing/render-row'
import { WORKTREE_SIDEBAR_REVEAL_TOP_INSET } from '../../worktree-sidebar-reveal'
import { selectSidebarViewport } from './sidebar-viewport-selection'

describe('prepared sidebar commit ranges', () => {
  it('retains disjoint current and clamped landing viewports without mounting the intervening prefix', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => lineageRow(`row-${index}`, 0))
    const model = buildSidebarGeometry(rows)
    const boundaries = sidebarGeometryBoundaries(model, new Map())
    const selection = selectSidebarViewport({
      model,
      boundaries,
      rows,
      offset: 1200,
      target: boundaries.at(-1)! + 1000,
      viewport: 400,
      inset: 1,
      targets: [],
      stickyHeaderIndexes: [],
      rootByOuterIndex: new Map(model.roots.map((index) => [index, index]))
    })
    expect(selection.selected.has(10)).toBe(true)
    expect(selection.selected.has(4999)).toBe(true)
    expect(selection.selected.has(2500)).toBe(false)
    expect(selection.selected.size).toBeLessThan(60)
  })
})

it.each([
  { name: 'downward short card', offset: 1, index: 400, endAligned: true },
  { name: 'upward short card', offset: 30000, index: 200, endAligned: false },
  { name: 'last card at the scroll limit', offset: 1, index: 4999, endAligned: true }
])(
  'prepares the actual $name landing with unchanged logical overscan',
  ({ offset, index, endAligned }) => {
    const rows = Array.from({ length: 5000 }, (_, i) => lineageRow(`row-${i}`, 0))
    const model = buildSidebarGeometry(rows)
    const boundaries = sidebarGeometryBoundaries(
      model,
      new Map(model.slots.map((slot) => [slot.key, 38 + model.nodes[slot.node]!.gap]))
    )
    const viewport = 519
    const landing = endAligned
      ? boundaries[index]! + 38 + 1 - viewport
      : boundaries[index]! + 1 - WORKTREE_SIDEBAR_REVEAL_TOP_INSET
    const result = selectSidebarViewport({
      model,
      boundaries,
      rows,
      offset,
      target: offset,
      viewport,
      inset: 1,
      targets: [{ index, landing: true }],
      stickyHeaderIndexes: [],
      rootByOuterIndex: new Map()
    })
    const expected = new Set([
      ...sidebarViewportNodes(model, boundaries, offset - 1, viewport),
      ...sidebarViewportNodes(model, boundaries, landing - 1, viewport)
    ])
    expect(result.selected).toEqual(expected)
    expect(result.selected.size).toBeLessThanOrEqual(2 * (Math.ceil(viewport / 44) + 21))
    expect(result.selected.has(2500)).toBe(false)
  }
)

it('uses an expanded card full extent and retains its prefix for an oversized title reveal', () => {
  const rows: RenderRow[] = [
    ...Array.from({ length: 100 }, (_, i) => lineageRow(`before-${i}`, 0)),
    {
      type: 'lineage-group',
      key: 'tree',
      rows: [
        lineageRow('parent', 0),
        ...Array.from({ length: 500 }, (_, i) => lineageRow(`child-${i}`, 1))
      ]
    }
  ]
  const model = buildSidebarGeometry(rows)
  const boundaries = sidebarGeometryBoundaries(model, new Map())
  const index = 100
  const viewport = 519
  const landing = boundaries[model.nodes[index]!.slot]! + 1 - WORKTREE_SIDEBAR_REVEAL_TOP_INSET
  const result = selectSidebarViewport({
    model,
    boundaries,
    rows,
    offset: 1,
    target: 1,
    viewport,
    inset: 1,
    targets: [{ index, landing: true }],
    stickyHeaderIndexes: [],
    rootByOuterIndex: new Map()
  })
  expect(result.selected).toEqual(
    retainSidebarAncestors(model, [
      ...sidebarViewportNodes(model, boundaries, 0, viewport),
      ...sidebarViewportNodes(model, boundaries, landing - 1, viewport)
    ])
  )
  expect(result.selected.has(101)).toBe(true)
  expect(result.selected.has(590)).toBe(false)
  expect(result.selected.size).toBeLessThan(60)
})

it('keeps an already visible target in the existing viewport without adding another range', () => {
  const rows = Array.from({ length: 100 }, (_, i) => lineageRow(`row-${i}`, 0))
  const model = buildSidebarGeometry(rows)
  const boundaries = sidebarGeometryBoundaries(model, new Map())
  const offset = boundaries[40]! - 100
  const result = selectSidebarViewport({
    model,
    boundaries,
    rows,
    offset,
    target: offset,
    viewport: 519,
    inset: 1,
    targets: [{ index: 40, landing: true }],
    stickyHeaderIndexes: [],
    rootByOuterIndex: new Map()
  })
  expect(result.selected).toEqual(new Set(sidebarViewportNodes(model, boundaries, offset - 1, 519)))
})
