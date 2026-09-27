import { Virtualizer, type VirtualizerOptions } from '@tanstack/react-virtual'
import { describe, expect, it, vi } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import {
  buildSidebarGeometry,
  sidebarGeometryBoundaries,
  sidebarChildSpans,
  type SidebarGeometry
} from '../listing/sidebar-geometry-slots'
import {
  getSidebarGeometryLedger,
  publishSidebarObservation,
  reconcileSidebarLedger
} from './sidebar-geometry-ledger'
import { synchronizeSidebarSizes } from './sidebar-size-synchronization'
import { sidebarGeometryConverged } from './sidebar-geometry-commit'

const rows = [
  lineageRow('parent', 0),
  ...Array.from({ length: 100 }, (_, n) => lineageRow(`child-${n}`, 1))
]
function modelFor(members = rows) {
  return buildSidebarGeometry([{ type: 'lineage-group', key: 'parent', rows: members }])
}
function fixture(ledger = getSidebarGeometryLedger({ current: null })) {
  const synchronized = new Map<string, number>()
  const options = (model: SidebarGeometry): VirtualizerOptions<HTMLDivElement, HTMLDivElement> => ({
    count: model.slots.length,
    getScrollElement: () => null,
    getItemKey: (index) => model.slots[index]!.key,
    estimateSize: (index) =>
      ledger.sizes.get(model.slots[index]!.key) ?? model.slots[index]!.estimate,
    initialRect: { width: 300, height: 400 },
    rangeExtractor: () => model.slots.map((_, index) => index),
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn()
  })
  const instance = new Virtualizer<HTMLDivElement, HTMLDivElement>(options(modelFor()))
  instance.shouldAdjustScrollPositionOnItemSizeChange = () => false
  function sync(model: SidebarGeometry) {
    reconcileSidebarLedger(ledger, model, false, 300)
    const boundaries = sidebarGeometryBoundaries(model, ledger.sizes)
    instance.setOptions(options(model))
    synchronizeSidebarSizes(model, boundaries, synchronized, instance)
    expect(
      sidebarGeometryConverged(
        model,
        boundaries,
        instance.getVirtualItems(),
        instance.getTotalSize()
      )
    ).toBe(true)
    return boundaries
  }
  return { ledger, instance, sync }
}
describe('lineage spacers agree with the single public geometry owner', () => {
  it.each([56, 140])(
    'keeps reintroduced descendants and spacers at the same size after collapse: %i',
    (observed) => {
      const { ledger, sync } = fixture()
      const full = modelFor()
      sync(full)
      publishSidebarObservation(ledger, full, 0, { prefix: 40, closing: 8, width: 300 })
      for (let index = 1; index < full.nodes.length; index++) {
        publishSidebarObservation(ledger, full, index, {
          prefix: observed,
          closing: null,
          width: 280
        })
      }
      sync(full)
      sync(buildSidebarGeometry([rows[0]!]))
      expect(ledger.sizes.size).toBe(0)
      const boundaries = sync(full)
      expect(sidebarChildSpans(full, full.nodes[0]!.children, new Set(), boundaries)).toEqual([
        {
          type: 'spacer',
          key: full.nodes[1]!.key,
          height: boundaries[full.nodes[0]!.close!]! - boundaries[full.nodes[1]!.slot]!
        }
      ])
    }
  )
  it('agrees after a fresh owner replaces an unmounted owner with surviving cached observations', () => {
    const { ledger, sync } = fixture()
    const model = modelFor()
    sync(model)
    publishSidebarObservation(ledger, model, 20, { prefix: 56, closing: null, width: 280 })
    sync(model)
    const remounted = fixture(ledger)
    const boundaries = remounted.sync(model)
    expect(boundaries[model.nodes[20]!.slot + 1]! - boundaries[model.nodes[20]!.slot]!).toBe(60)
  })
  it('agrees after a reorder retaining occurrence keys and invalidating changed sibling context', () => {
    const { ledger, sync } = fixture()
    const full = modelFor()
    sync(full)
    for (let index = 1; index < full.nodes.length; index++) {
      publishSidebarObservation(ledger, full, index, { prefix: 56, closing: null, width: 280 })
    }
    sync(full)
    const reordered = modelFor([rows[0]!, ...rows.slice(1).toReversed()])
    const boundaries = sync(reordered)
    const middle = reordered.nodes[50]!
    expect(boundaries[middle.slot + 1]! - boundaries[middle.slot]!).toBe(60)
  })
})
