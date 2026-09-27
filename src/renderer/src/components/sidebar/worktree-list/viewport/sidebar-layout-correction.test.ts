import { describe, expect, it } from 'vitest'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { buildSidebarGeometry, sidebarGeometryBoundaries } from '../listing/sidebar-geometry-slots'
import { getSidebarGeometryLedger, publishSidebarObservation } from './sidebar-geometry-ledger'
import { createSidebarLayoutCorrection } from './sidebar-layout-correction'
import { resolveSidebarCorrectionTarget } from './sidebar-geometry-commit'

function fixture() {
  const rows = [lineageRow('a', 0), lineageRow('b', 0), lineageRow('c', 0)]
  const previous = buildSidebarGeometry(rows, () => ({
    own: 116,
    prefix: 121,
    closing: 7,
    fingerprint: 'known'
  }))
  const model = buildSidebarGeometry(rows)
  const ledger = getSidebarGeometryLedger({ current: null })
  previous.nodes.forEach((_, index) =>
    publishSidebarObservation(ledger, previous, index, { prefix: 116, closing: null, width: 300 })
  )
  const args: Parameters<typeof createSidebarLayoutCorrection>[0] = {
    previous,
    model,
    ledger,
    anchor: { key: previous.nodes[1]!.key, offset: 79, scrollTop: 200 },
    pending: null,
    rounding: { offset: 200, remainder: -0.5, epoch: 3 },
    physicalOffset: 200,
    epoch: 3,
    inset: 1
  }
  const resolve = (correction: ReturnType<typeof createSidebarLayoutCorrection>) =>
    resolveSidebarCorrectionTarget(
      correction,
      model,
      sidebarGeometryBoundaries(model, ledger.sizes),
      1,
      200
    )
  return { args, resolve, rows }
}

describe('same-topology card shape correction', () => {
  it('captures fractional logical position before invalidating measured sizes', () => {
    const { args, resolve } = fixture()
    const correction = createSidebarLayoutCorrection(args)
    expect(correction?.layoutAnchor).toBe(true)
    expect(resolve(correction)).toBe(199.5)
    publishSidebarObservation(args.ledger, args.model, 0, {
      prefix: 153.5,
      closing: null,
      width: 300
    })
    expect(resolve(correction)).toBe(237)
  })
  it('transfers a valid unpublished numeric target exactly once', () => {
    const { args, resolve } = fixture()
    args.pending = { target: 237.5, epoch: 3, sourceOffset: 200 }
    publishSidebarObservation(args.ledger, args.previous!, 0, {
      prefix: 153.5,
      closing: null,
      width: 300
    })
    const correction = createSidebarLayoutCorrection(args)
    expect(resolve(correction)).toBe(237.5)
    publishSidebarObservation(args.ledger, args.model, 0, {
      prefix: 116,
      closing: null,
      width: 300
    })
    expect(resolve(correction)).toBe(200)
  })
  it('keeps a pending shape anchor identity even if the capture ref changes', () => {
    const { args, resolve } = fixture()
    args.pending = createSidebarLayoutCorrection(args)
    args.anchor = { key: args.model.nodes[2]!.key, offset: 0, scrollTop: 200 }
    const correction = createSidebarLayoutCorrection(args)
    expect(correction?.anchor?.key).toBe(args.model.nodes[1]!.key)
    expect(resolve(correction)).toBe(199.5)
  })
  it.each(['epoch', 'physical', 'navigation', 'semantic'] as const)(
    'rejects a pending correction after %s changes ownership',
    (kind) => {
      const { args } = fixture()
      args.pending = {
        target: 237.5,
        epoch: kind === 'epoch' ? 2 : 3,
        sourceOffset: kind === 'physical' ? 199 : 200
      }
      if (kind === 'navigation') {
        args.pending.navigation = {
          key: args.model.nodes[2]!.key,
          align: 'start',
          behavior: 'auto'
        }
      }
      if (kind === 'semantic') {
        args.pending.anchor = args.anchor
      }
      expect(createSidebarLayoutCorrection(args)).toBeNull()
    }
  )
  it.each(['order', 'identity', 'depth'] as const)(
    'rejects a %s change even with a valid residual',
    (kind) => {
      const { args, rows } = fixture()
      args.model = buildSidebarGeometry(
        kind === 'order'
          ? rows.toReversed()
          : [
              lineageRow(kind === 'identity' ? 'other' : 'a', kind === 'depth' ? 1 : 0),
              ...rows.slice(1)
            ]
      )
      expect(createSidebarLayoutCorrection(args)).toBeNull()
    }
  )
  it.each(['epoch', 'physical'] as const)(
    'ignores a residual whose %s no longer matches',
    (kind) => {
      const { args, resolve } = fixture()
      args.rounding = {
        offset: kind === 'physical' ? 199 : 200,
        remainder: -0.5,
        epoch: kind === 'epoch' ? 2 : 3
      }
      expect(resolve(createSidebarLayoutCorrection(args))).toBe(200)
    }
  )
  it('cannot transfer a missing reading key', () => {
    const { args } = fixture()
    args.anchor = { key: 'missing', offset: 0, scrollTop: 200 }
    expect(createSidebarLayoutCorrection(args)).toBeNull()
  })
})
