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
  const rows = [lineageRow('a', 0), lineageRow('b', 0)]
  const previous = buildSidebarGeometry(rows, () => ({
    own: 116,
    prefix: 121,
    closing: 7,
    fingerprint: 'known'
  }))
  const model = buildSidebarGeometry(rows)
  const ledger = getSidebarGeometryLedger({ current: null })
  reconcileSidebarLedger(ledger, previous, false, 300)
  publishSidebarObservation(ledger, previous, 0, { prefix: 116, closing: null, width: 300 })
  const args: Parameters<typeof publishSidebarMeasurements>[0] = {
    model,
    publishedModel: { current: previous },
    ledger,
    boundaries: sidebarGeometryBoundaries(model, ledger.sizes),
    newCardStyle: false,
    scrollAnchorRef: { current: null },
    scrollRef: { current: null },
    correction: { current: null },
    rounding: { current: null },
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
    offset: 40,
    virtualizer: { isScrolling: false, scrollDirection: null },
    changed: vi.fn()
  }
  return args
}

describe('shape transition measurement eligibility', () => {
  it('does not turn a measured fold-spanning card into a first observation', () => {
    const args = fixture()
    publishSidebarMeasurements(
      args,
      new Map([[args.model.nodes[0]!.key, { prefix: 153.5, closing: null, width: 300 }]]),
      300,
      false
    )
    expect(args.correction.current).toBeNull()
    expect(args.ledger.sizes.get(args.model.slots[0]!.key)).toBe(153.5 + args.model.nodes[0]!.gap)
  })
  it('keeps first-observation adjustment for a previously unknown unmeasured card', () => {
    const args = fixture()
    args.ledger.sizes.clear()
    args.ledger.observed.clear()
    args.boundaries = sidebarGeometryBoundaries(args.model, args.ledger.sizes)
    publishSidebarMeasurements(
      args,
      new Map([[args.model.nodes[0]!.key, { prefix: 153.5, closing: null, width: 300 }]]),
      300,
      false
    )
    expect(args.correction.current?.target).toBe(
      40 + 153.5 + args.model.nodes[0]!.gap - args.boundaries[1]!
    )
  })
  it.each(['missing', 'invalid'] as const)(
    'does not carry prior eligibility after a %s transition sample',
    (kind) => {
      const args = fixture()
      const key = args.model.nodes[0]!.key
      publishSidebarMeasurements(
        args,
        kind === 'missing'
          ? new Map()
          : new Map([[key, { prefix: 153.5, closing: 7, width: 300 }]]),
        300,
        false
      )
      expect(args.changed).toHaveBeenCalledTimes(1)
      expect(args.ledger.observed.has(args.model.slots[0]!.key)).toBe(false)
      expect(args.ledger.sizes.has(args.model.slots[0]!.key)).toBe(false)
      args.boundaries = sidebarGeometryBoundaries(args.model, args.ledger.sizes)
      publishSidebarMeasurements(
        args,
        new Map([[key, { prefix: 153.5, closing: null, width: 300 }]]),
        300,
        false
      )
      expect(args.correction.current?.target).toBe(
        40 + 153.5 + args.model.nodes[0]!.gap - args.boundaries[1]!
      )
    }
  )
  it.each(['prefix', 'closing'] as const)(
    'preserves fold eligibility separately for measured expanded %s',
    (part) => {
      const model = buildSidebarGeometry([
        {
          type: 'lineage-group',
          key: 'root',
          rows: [lineageRow('root', 0), lineageRow('child', 1)]
        }
      ])
      const ledger = getSidebarGeometryLedger({ current: null })
      publishSidebarObservation(ledger, model, 0, { prefix: 121, closing: 7, width: 300 })
      const boundaries = sidebarGeometryBoundaries(model, ledger.sizes)
      const previouslyObserved = new Set(ledger.observed)
      ledger.sizes.clear()
      ledger.observed.clear()
      const close = model.nodes[0]!.close!
      const scrollOffset = part === 'prefix' ? 40 : boundaries[close]! + 3
      const result = applySidebarMeasurements({
        model,
        ledger,
        boundaries,
        previouslyObserved,
        samples: new Map([
          [
            model.nodes[0]!.key,
            {
              prefix: part === 'prefix' ? 158.5 : 121,
              closing: part === 'closing' ? 44.5 : 7,
              width: 300
            }
          ]
        ]),
        inset: 1,
        scrollOffset,
        now: 1000,
        suppressUntil: 0,
        isScrolling: false,
        scrollDirection: null
      })
      expect(result.changed).toBe(true)
      expect(result.delta).toBe(0)
    }
  )
})
