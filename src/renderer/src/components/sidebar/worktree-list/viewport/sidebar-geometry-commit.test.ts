import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { buildSidebarGeometry, sidebarGeometryBoundaries } from '../listing/sidebar-geometry-slots'
import {
  getSidebarGeometryLedger,
  reconcileSidebarLedger,
  publishSidebarObservation
} from './sidebar-geometry-ledger'
import {
  resolveSidebarCorrectionTarget,
  clampSidebarOffset,
  sidebarNavigationOffset
} from './sidebar-geometry-commit'

describe('matching sidebar commit geometry', () => {
  it.each([160, 900])('preserves explicit subtree alignments for height %i', (height) => {
    const start = 1_000,
      end = start + height
    expect(sidebarNavigationOffset(start, end, 0, 600, 34, 'start')).toBe(966)
    expect(sidebarNavigationOffset(start, end, 0, 600, 34, 'center')).toBe((start + end - 600) / 2)
    expect(sidebarNavigationOffset(start, end, 0, 600, 34, 'end')).toBe(end - 600)
  })
  it('keeps auto fitting, oversized and measured readable-title policies consistent', () => {
    expect(sidebarNavigationOffset(1_000, 1_160, 0, 600, 34, 'auto')).toBe(560)
    expect(sidebarNavigationOffset(1_000, 1_900, 0, 600, 34, 'auto')).toBe(966)
    expect(sidebarNavigationOffset(1_000, 1_900, 700, 600, 34, 'auto', 1_026)).toBe(700)
    expect(sidebarNavigationOffset(1_000, 1_900, 990, 600, 34, 'auto', 1_026)).toBe(966)
  })

  it('resolves structural anchors again after an unmounted cached sibling loses its following gap', () => {
    const p = lineageRow('p', 0),
      a = lineageRow('a', 1),
      b = lineageRow('b', 1),
      c = lineageRow('c', 0)
    const old = buildSidebarGeometry([{ type: 'lineage-group', key: 'p', rows: [p, a, b] }, c])
    const ledger = getSidebarGeometryLedger({ current: null })
    reconcileSidebarLedger(ledger, old, false, 300)
    publishSidebarObservation(ledger, old, 1, { prefix: 40, closing: null, width: 290 })
    const model = buildSidebarGeometry([{ type: 'lineage-group', key: 'p', rows: [p, a] }, c])
    const stale = sidebarGeometryBoundaries(model, ledger.sizes)
    const correction = { target: 0, epoch: 0, anchor: { key: model.nodes[2]!.key, offset: 3 } }
    const staleTarget = resolveSidebarCorrectionTarget(correction, model, stale, 1, 0)
    reconcileSidebarLedger(ledger, model, false, 300)
    const fresh = sidebarGeometryBoundaries(model, ledger.sizes)
    const target = resolveSidebarCorrectionTarget(correction, model, fresh, 1, 0)
    expect(target).toBe(fresh[model.nodes[2]!.slot]! + 4)
    expect(target).not.toBe(staleTarget)
  })
  it('uses the real content inset and rounded browser extent for bottom clamping', () => {
    expect(clampSidebarOffset(1000, 500.4, 100, 1)).toBe(401)
    expect(clampSidebarOffset(1000, 500.6, 100, 1)).toBe(402)
    expect(clampSidebarOffset(10, 50, 100, 1)).toBe(0)
  })
})
