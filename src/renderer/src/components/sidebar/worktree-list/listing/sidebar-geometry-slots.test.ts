import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import {
  buildSidebarGeometry,
  sidebarGeometryBoundaries,
  sidebarChildSpans,
  sidebarViewportNodes,
  retainSidebarAncestors
} from './sidebar-geometry-slots'

function nested() {
  return buildSidebarGeometry([
    {
      type: 'lineage-group',
      key: 'group',
      rows: [
        lineageRow('parent', 0),
        lineageRow('child', 1),
        lineageRow('grandchild', 2),
        lineageRow('sibling', 1)
      ]
    },
    lineageRow('next', 0)
  ])
}

describe('sidebar global geometry', () => {
  it('carries target host clearance to nested semantic cards without changing no-host rows', () => {
    expect(nested().nodes.every((node) => node.revealTopInset === 34)).toBe(true)
    const model = buildSidebarGeometry([
      {
        type: 'host-header',
        key: 'host:ssh:box',
        hostId: 'ssh:box',
        kind: 'ssh',
        label: 'Remote',
        detail: '',
        health: 'available',
        collapsed: false,
        count: 2
      },
      {
        type: 'lineage-group',
        key: 'tree',
        rows: [lineageRow('parent', 0), lineageRow('child', 1)]
      }
    ])
    expect(model.nodes.map((node) => node.revealTopInset)).toEqual([34, 70, 70])
  })

  it('places closing chrome after children and conserves nested spacers', () => {
    const model = nested()
    expect(model.slots.map((slot) => slot.kind)).toEqual([
      'prefix',
      'prefix',
      'row',
      'closing',
      'row',
      'closing',
      'row'
    ])
    const values = [40, 30, 50, 11, 60, 13, 70]
    const sizes = new Map(model.slots.map((slot, index) => [slot.key, values[index]!]))
    const b = sidebarGeometryBoundaries(model, sizes)
    expect(b).toEqual([0, 40, 70, 120, 131, 191, 204, 274])
    expect(sidebarChildSpans(model, model.nodes[0]!.children, new Set([3]), b)).toEqual([
      { type: 'spacer', key: model.nodes[1]!.key, height: 87 },
      { type: 'row', node: 3 }
    ])
    sizes.set(model.slots[1]!.key, 67)
    expect(sidebarGeometryBoundaries(model, sizes)).toEqual([0, 40, 107, 157, 168, 228, 241, 311])
    sizes.set(model.slots[3]!.key, 4)
    expect(sidebarGeometryBoundaries(model, sizes)[2]).toBe(107)
  })

  it.each([500, 5000])(
    'keeps viewport and end closing selection bounded with %i children',
    (count) => {
      const model = buildSidebarGeometry([
        {
          type: 'lineage-group',
          key: 'group',
          rows: [
            lineageRow('parent', 0),
            ...Array.from({ length: count }, (_, n) => lineageRow(`child-${n}`, 1))
          ]
        }
      ])
      const sizes = new Map(
        model.slots.map((slot) => [slot.key, slot.kind === 'closing' ? 12 : 40])
      )
      const b = sidebarGeometryBoundaries(model, sizes)
      for (const offset of [8000, b.at(-1)! - 120]) {
        const retained = retainSidebarAncestors(model, sidebarViewportNodes(model, b, offset, 400))
        expect(retained.size).toBeLessThanOrEqual(32)
        expect(retained.has(0)).toBe(true)
      }
      const middle = sidebarViewportNodes(model, b, 8000, 400)
      expect(middle).toHaveLength(30)
    }
  )

  it('keeps card identity while changing leaf shape and reparenting', () => {
    const initial = nested()
    const collapsed = buildSidebarGeometry([lineageRow('parent', 0), lineageRow('next', 0)])
    expect(initial.nodes[0]!.key).toBe(collapsed.nodes[0]!.key)
    expect(initial.slots[0]!.key).not.toBe(collapsed.slots[0]!.key)
    const moved = buildSidebarGeometry([
      {
        type: 'lineage-group',
        key: 'other',
        rows: [lineageRow('other', 0), lineageRow('child', 1)]
      }
    ])
    expect(moved.nodes[1]!.key).toBe(initial.nodes[1]!.key)
    expect(moved.nodes[1]!.parent).toBe(0)
  })
  it('maps a viewport wholly inside closing chrome only to the owning card, never an interactive closing row', () => {
    const model = nested()
    const sizes = new Map(model.slots.map((slot) => [slot.key, slot.kind === 'closing' ? 80 : 20]))
    const b = sidebarGeometryBoundaries(model, sizes)
    const close = model.nodes[0]!.close!
    expect(sidebarViewportNodes(model, b, b[close]! + 10, 10, 0)).toEqual([0])
    expect(model.nodes[0]!.row.type).toBe('item')
  })
  it('keeps same-id host and pinned occurrences independent', () => {
    const local = lineageRow('same', 0)
    const remote = {
      ...lineageRow('same', 0),
      rowKey: 'all:ssh:remote|same',
      worktree: { ...local.worktree, hostId: 'ssh:remote' as const }
    }
    const pinned = { ...local, rowKey: 'pinned:local|same', sectionKey: 'pinned' }
    const model = buildSidebarGeometry([local, remote, pinned])
    expect(new Set(model.nodes.map((node) => node.key)).size).toBe(3)
    expect(model.nodeByRowKey.get(remote.rowKey)).toBe(1)
    expect(model.nodeByRowKey.get(pinned.rowKey)).toBe(2)
  })
})
