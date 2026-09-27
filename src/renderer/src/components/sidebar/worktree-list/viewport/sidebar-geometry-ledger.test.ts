// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { lineageRow, geometryFolderRow } from '../rows/lineage-virtualization-test-fixtures'
import { buildSidebarGeometry } from '../listing/sidebar-geometry-slots'
import {
  getSidebarGeometryLedger,
  publishSidebarObservation,
  reconcileSidebarLedger,
  readSidebarObservation,
  type SidebarGeometryOwner
} from './sidebar-geometry-ledger'

describe('sidebar geometry ledger', () => {
  it('preserves observed-at-estimate across remount and invalidates width, style and shape', () => {
    const owner: SidebarGeometryOwner = { current: null }
    const ledger = getSidebarGeometryLedger(owner)
    const leaf = buildSidebarGeometry([lineageRow('root', 0)])
    reconcileSidebarLedger(ledger, leaf, false, 300)
    expect(
      publishSidebarObservation(ledger, leaf, 0, { prefix: 116, closing: null, width: 300 })
    ).toBe(true)
    expect(
      publishSidebarObservation(ledger, leaf, 0, { prefix: 116, closing: null, width: 300 })
    ).toBe(false)
    owner.current = { key: leaf.nodes[0]!.key, offset: 10, scrollTop: 10 }
    expect(getSidebarGeometryLedger(owner)).toBe(ledger)
    expect(getSidebarGeometryLedger({ current: owner.current })).not.toBe(ledger)
    expect(ledger.observed.has(leaf.slots[0]!.key)).toBe(true)
    reconcileSidebarLedger(ledger, leaf, false, 301)
    expect(ledger.observed.size).toBe(0)
    publishSidebarObservation(ledger, leaf, 0, { prefix: 116, closing: null, width: 301 })
    reconcileSidebarLedger(ledger, leaf, true, 301)
    expect(ledger.sizes.size).toBe(0)
    publishSidebarObservation(ledger, leaf, 0, { prefix: 116, closing: null, width: 301 })
    const expanded = buildSidebarGeometry([
      { type: 'lineage-group', key: 'root', rows: [lineageRow('root', 0), lineageRow('child', 1)] }
    ])
    reconcileSidebarLedger(ledger, expanded, true, 301)
    expect(ledger.sizes.size).toBe(0)
  })

  it('rejects a stale leaf observation after expansion', () => {
    const model = buildSidebarGeometry([
      { type: 'lineage-group', key: 'root', rows: [lineageRow('root', 0), lineageRow('child', 1)] }
    ])
    const ledger = getSidebarGeometryLedger({ current: null })
    expect(
      publishSidebarObservation(ledger, model, 0, { prefix: 100, closing: null, width: 300 })
    ).toBe(false)
    expect(ledger.sizes.size).toBe(0)
  })

  it('does not read disconnected element geometry', () => {
    const node = document.createElement('div')
    node.getBoundingClientRect = () => {
      throw new Error('stale geometry read')
    }
    expect(readSidebarObservation(node, null)).toBeNull()
  })
  it('cancels the existing root content removal translation without changing fractional geometry', () => {
    const outer = document.createElement('div')
    outer.setAttribute('data-worktree-virtual-row', '')
    const content = document.createElement('div')
    const children = document.createElement('div')
    outer.append(content)
    content.append(children)
    document.body.append(outer)
    outer.getBoundingClientRect = () => new DOMRect(0, 100, 300, 200)
    content.getBoundingClientRect = () => new DOMRect(0, 137, 300, 200)
    children.getBoundingClientRect = () => new DOMRect(0, 177.25, 280, 150.5)
    expect(readSidebarObservation(outer, children)).toEqual({
      prefix: 40.25,
      closing: 9.25,
      width: 300
    })
    outer.remove()
  })

  it('invalidates an unmounted folder when group depth changes at the same scroller width', () => {
    const ledger = getSidebarGeometryLedger({ current: null })
    const first = buildSidebarGeometry([geometryFolderRow(1)])
    reconcileSidebarLedger(ledger, first, false, 300)
    publishSidebarObservation(ledger, first, 0, { prefix: 100, closing: null, width: 300 })
    const deeper = buildSidebarGeometry([geometryFolderRow(3)])
    expect(reconcileSidebarLedger(ledger, deeper, false, 300)).toBe(true)
    expect(ledger.sizes.size).toBe(0)
  })
})
