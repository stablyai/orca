import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { buildLineageVirtualTree } from './lineage-virtual-tree'
import { buildSidebarGeometry, retainSidebarAncestors } from './sidebar-geometry-slots'

describe('lineage virtual tree', () => {
  it('indexes a deep chain in one pass and retains only the requested ancestor path', () => {
    const rows = Array.from({ length: 2000 }, (_, n) => lineageRow(`child-${n}`, n + 1))
    rows.push(lineageRow('other-root'), lineageRow('other-child', 2))
    const tree = buildLineageVirtualTree(rows)
    expect(tree.roots).toEqual([0, 2000])
    expect(tree.nodes[0]?.endIndex).toBe(2000)
    expect(tree.nodes[1999]?.parentIndex).toBe(1998)
    const model = buildSidebarGeometry([{ type: 'lineage-group', key: 'all', rows }])
    expect(retainSidebarAncestors(model, [2001])).toEqual(new Set([2001, 2000]))
  })
})
