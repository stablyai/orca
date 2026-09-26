import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import {
  buildLineageVirtualTree,
  getLineageRevealMeasurementIndexes,
  getLineageVirtualChildSpans,
  getLineageVirtualOffsets,
  retainLineageVirtualAncestors
} from './lineage-virtual-tree'

describe('lineage virtual tree', () => {
  it('premeasures a reveal viewport and overscan as estimated rows shrink to actual heights', () => {
    const tree = buildLineageVirtualTree(
      Array.from({ length: 500 }, (_, n) => lineageRow(`child-${n}`))
    )
    const estimated = getLineageVirtualOffsets(tree, new Map())
    const measured = getLineageVirtualOffsets(
      tree,
      new Map(tree.nodes.map((node) => [node.row.rowKey, 40]))
    )
    expect(getLineageRevealMeasurementIndexes(400, estimated, 400)).toEqual(
      Array.from({ length: 31 }, (_, n) => n + 385)
    )
    expect(getLineageRevealMeasurementIndexes(400, measured, 400)).toEqual(
      Array.from({ length: 41 }, (_, n) => n + 380)
    )
    expect(getLineageRevealMeasurementIndexes(0, measured, 400)[0]).toBe(0)
    expect(getLineageRevealMeasurementIndexes(499, measured, 400).at(-1)).toBe(499)
  })

  it('indexes a deep chain in one pass and retains only the requested ancestor path', () => {
    const rows = Array.from({ length: 2000 }, (_, n) => lineageRow(`child-${n}`, n + 1))
    rows.push(lineageRow('other-root'), lineageRow('other-child', 2))
    const tree = buildLineageVirtualTree(rows)
    expect(tree.roots).toEqual([0, 2000])
    expect(tree.nodes[0]?.endIndex).toBe(2000)
    expect(tree.nodes[1999]?.parentIndex).toBe(1998)
    expect(retainLineageVirtualAncestors(tree, [2001])).toEqual(new Set([2001, 2000]))
  })

  it('coalesces hidden sibling subtrees and preserves their measured height including gaps', () => {
    const rows = [
      lineageRow('first'),
      lineageRow('nested', 2),
      lineageRow('second'),
      lineageRow('third')
    ]
    const tree = buildLineageVirtualTree(rows)
    const offsets = getLineageVirtualOffsets(tree, new Map(rows.map((row) => [row.rowKey, 100])))
    expect(getLineageVirtualChildSpans(tree, tree.roots, new Set([2]), offsets)).toEqual([
      { type: 'spacer', key: rows[0]!.rowKey, height: 196 },
      { type: 'row', index: 2 },
      { type: 'spacer', key: rows[3]!.rowKey, height: 100 }
    ])
    expect(getLineageVirtualChildSpans(tree, tree.roots, new Set(), offsets)).toEqual([
      { type: 'spacer', key: rows[0]!.rowKey, height: 400 }
    ])
  })
})
