import { describe, expect, it, vi } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { buildSidebarGeometry, sidebarGeometryBoundaries } from '../listing/sidebar-geometry-slots'
import {
  getSidebarGeometryLedger,
  publishSidebarObservation,
  reconcileSidebarLedger
} from './sidebar-geometry-ledger'
import {
  applySidebarMeasurements,
  publishSidebarMeasurements
} from './sidebar-measurement-publication'

function fixture() {
  const model = buildSidebarGeometry([lineageRow('a', 0), lineageRow('b', 0), lineageRow('c', 0)])
  const ledger = getSidebarGeometryLedger({ current: null })
  for (let index = 0; index < 3; index++) {
    publishSidebarObservation(ledger, model, index, { prefix: 100, closing: null, width: 300 })
  }
  return {
    model,
    ledger,
    boundaries: sidebarGeometryBoundaries(model, ledger.sizes),
    inset: 1,
    scrollOffset: 250,
    now: 1000,
    suppressUntil: 0,
    isScrolling: false,
    scrollDirection: null
  }
}
describe('sidebar measurement publication', () => {
  it.each([false, true])(
    'uses the carried fold for fractional first-observation eligibility %s',
    (first) => {
      for (const remainder of [-0.5, 0.5]) {
        const { model, ledger } = fixture()
        reconcileSidebarLedger(ledger, model, false, 300)
        const prefix = remainder < 0 ? 99.75 : 99.25
        publishSidebarObservation(ledger, model, 0, { prefix, closing: null, width: 300 })
        publishSidebarObservation(ledger, model, 1, { prefix: 100, closing: null, width: 300 })
        const node = model.nodes[first ? 1 : 0]!
        if (first) {
          ledger.observed.delete(model.slots[node.slot]!.key)
        }
        const physicalOffset = first ? (remainder < 0 ? 107 : 106) : remainder < 0 ? 101 : 100
        const args: Parameters<typeof publishSidebarMeasurements>[0] = {
          model,
          publishedModel: { current: model },
          ledger,
          boundaries: sidebarGeometryBoundaries(model, ledger.sizes),
          newCardStyle: false,
          scrollAnchorRef: { current: null },
          scrollRef: { current: null },
          correction: { current: null },
          rounding: { current: { offset: physicalOffset, remainder, epoch: 0 } },
          suppression: {
            scrollOwnershipEpochRef: { current: 0 },
            suppressMeasurementAdjustmentUntilRef: { current: 0 },
            directScrollInputUntilRef: { current: 0 },
            markScrollMovement: vi.fn(),
            markDirectScrollInput: vi.fn(),
            hasDirectScrollInput: () => false,
            markRevealScroll: vi.fn(),
            isRevealScrollSettling: () => false,
            wasRevealScrollInterrupted: () => false,
            shouldSkipScrollAnchorRestore: () => false
          },
          insetRef: { current: 1 },
          offset: physicalOffset,
          virtualizer: { isScrolling: false, scrollDirection: null },
          changed: vi.fn()
        }
        publishSidebarMeasurements(
          args,
          new Map([[node.key, { prefix: (first ? 100 : prefix) + 50, closing: null, width: 300 }]]),
          300,
          false
        )
        expect(args.correction.current?.target ?? null).toBe(
          remainder < 0 ? null : physicalOffset + remainder + 50
        )
      }
    }
  )
  it('counts two publications against the last published observation, not the old committed size twice', () => {
    const args = fixture()
    const a = args.model.nodes[0]!.key
    const b = args.model.nodes[1]!.key
    const first = applySidebarMeasurements({
      ...args,
      samples: new Map([[a, { prefix: 110, closing: null, width: 300 }]])
    })
    const second = applySidebarMeasurements({
      ...args,
      samples: new Map([
        [a, { prefix: 110, closing: null, width: 300 }],
        [b, { prefix: 120, closing: null, width: 300 }]
      ])
    })
    expect(first.delta + second.delta).toBe(30)
    expect(second.delta).toBe(20)
  })
  it('does not compensate an observed fold-spanning card or user-suppressed publication', () => {
    const args = fixture()
    const sample = new Map([[args.model.nodes[1]!.key, { prefix: 140, closing: null, width: 300 }]])
    expect(applySidebarMeasurements({ ...args, scrollOffset: 150, samples: sample }).delta).toBe(0)
    expect(
      applySidebarMeasurements({
        ...args,
        suppressUntil: 2000,
        samples: new Map([[args.model.nodes[0]!.key, { prefix: 150, closing: null, width: 300 }]])
      }).delta
    ).toBe(0)
  })
  it('records first observations at estimate and never compensates a stale shape', () => {
    const args = fixture()
    const result = applySidebarMeasurements({
      ...args,
      samples: new Map([[args.model.nodes[0]!.key, { prefix: 150, closing: 10, width: 300 }]])
    })
    expect(result).toEqual({ changed: false, delta: 0 })
  })
  it('publishes independent parent and child changes once without counting nested height twice', () => {
    const model = buildSidebarGeometry([
      {
        type: 'lineage-group',
        key: 'root',
        rows: [lineageRow('root', 0), lineageRow('a', 1), lineageRow('b', 1)]
      }
    ])
    const ledger = getSidebarGeometryLedger({ current: null })
    publishSidebarObservation(ledger, model, 0, { prefix: 100, closing: 10, width: 300 })
    publishSidebarObservation(ledger, model, 1, { prefix: 100, closing: null, width: 280 })
    publishSidebarObservation(ledger, model, 2, { prefix: 100, closing: null, width: 280 })
    const boundaries = sidebarGeometryBoundaries(model, ledger.sizes)
    const args = {
      ...fixture(),
      model,
      ledger,
      boundaries,
      samples: new Map([
        [model.nodes[0]!.key, { prefix: 137, closing: 10, width: 300 }],
        [model.nodes[1]!.key, { prefix: 153, closing: null, width: 280 }]
      ])
    }
    expect(applySidebarMeasurements(args).delta).toBe(90)
    expect(sidebarGeometryBoundaries(model, ledger.sizes).at(-1)! - boundaries.at(-1)!).toBe(90)
  })
  it('preserves existing outer-shift anchor precedence during movement suppression, but direct input cancels it', () => {
    const args = fixture()
    const samples = new Map([
      [args.model.nodes[0]!.key, { prefix: 137, closing: null, width: 300 }]
    ])
    expect(
      applySidebarMeasurements({
        ...args,
        suppressUntil: 2000,
        anchorOuterIndex: 2,
        skipAnchorRestore: false,
        samples
      }).delta
    ).toBe(37)
    const cancelled = fixture()
    expect(
      applySidebarMeasurements({
        ...cancelled,
        suppressUntil: 2000,
        anchorOuterIndex: 2,
        skipAnchorRestore: true,
        samples
      }).delta
    ).toBe(0)
  })
})

it('excludes the following gap when checking fully above-fold leaf and closing measurements', () => {
  for (const expanded of [false, true]) {
    const model = buildSidebarGeometry([
      ...(expanded
        ? [
            {
              type: 'lineage-group' as const,
              key: 'root',
              rows: [lineageRow('a', 0), lineageRow('child', 1)]
            }
          ]
        : [lineageRow('a', 0)]),
      lineageRow('b', 0)
    ])
    const ledger = getSidebarGeometryLedger({ current: null })
    const observation = { prefix: 100, closing: expanded ? 10 : null, width: 300 }
    publishSidebarObservation(ledger, model, 0, observation)
    const boundaries = sidebarGeometryBoundaries(model, ledger.sizes)
    const node = model.nodes[0]!
    const result = applySidebarMeasurements({
      ...fixture(),
      model,
      ledger,
      boundaries,
      scrollOffset: boundaries[node.end]! - node.gap / 2 + 1,
      samples: new Map([
        [node.key, expanded ? { ...observation, closing: 47 } : { ...observation, prefix: 137 }]
      ])
    })
    expect(result.delta).toBe(37)
  }
})
