import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../../shared/worktree/card-properties'
import { makeRepo } from '../../worktree-list-lineage-card-test-fixtures'
import { lineageRow } from '../rows/lineage-virtualization-test-fixtures'
import { resolveSidebarCardGeometry, type SidebarCardGeometryInputs } from './sidebar-card-geometry'
import { buildSidebarGeometry, sidebarGeometryBoundaries } from './sidebar-geometry-slots'
import {
  getSidebarGeometryLedger,
  publishSidebarObservation,
  reconcileSidebarLedger,
  sidebarGeometryLayoutMatches
} from '../viewport/sidebar-geometry-ledger'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'

function inputs(newCardStyle = true): SidebarCardGeometryInputs {
  return {
    newCardStyle,
    compactPreference: false,
    cardProps: DEFAULT_WORKTREE_CARD_PROPERTIES,
    hasProjectGroups: false,
    hideRepoBadge: false,
    agentCandidateIds: new Set(),
    blockedIds: new Set()
  }
}
function row(id: string, depth = 1) {
  return { ...lineageRow(id, depth), repo: makeRepo() }
}

describe('presentation-derived cold card estimates', () => {
  it('distinguishes the actual default no-identity lane from opt-in branch and legacy repo metadata', () => {
    const leaf = row('leaf')
    expect(resolveSidebarCardGeometry(leaf, false, inputs())).toMatchObject({ own: 33 })
    expect(
      resolveSidebarCardGeometry(leaf, false, {
        ...inputs(),
        cardProps: [...DEFAULT_WORKTREE_CARD_PROPERTIES, 'branch']
      })
    ).toMatchObject({ own: 50 })
    expect(resolveSidebarCardGeometry(leaf, false, inputs(false))).toMatchObject({ own: 55 })
  })
  it.each([true, false])(
    'conserves prefix/closing geometry with style %s and default detail properties',
    (style) => {
      const parent = { ...row('parent', 0), lineageChildCount: 1, lineageGroupKey: 'parent' }
      const child = row('child')
      const values = inputs(style)
      const model = buildSidebarGeometry(
        [{ type: 'lineage-group', key: 'parent', rows: [parent, child] }],
        (row, expanded) => resolveSidebarCardGeometry(row, expanded, values)
      )
      expect(model.slots.map((slot) => slot.kind)).toEqual(['prefix', 'row', 'closing'])
      expect(model.slots.map((slot) => slot.estimate)).toEqual(style ? [60, 33, 7] : [88, 55, 7])
      const collapsed = resolveSidebarCardGeometry(
        { ...parent, lineageCollapsed: true },
        false,
        values
      )!
      expect(collapsed.own).toBe(style ? 61 : 83)
      expect(model.slots[0]!.estimate + model.slots[2]!.estimate).toBe(
        collapsed.own + (style ? 6 : 12)
      )
    }
  )
  it('keeps unsupported shapes as fallback and does not conflate pinned or same-id occurrences', () => {
    const plain = row('same')
    const pinned = { ...plain, sectionKey: PINNED_GROUP_KEY, rowKey: 'pinned:same' }
    expect(resolveSidebarCardGeometry(plain, false, inputs(false))?.own).toBe(55)
    expect(resolveSidebarCardGeometry(pinned, false, inputs(false))).toBeNull()
    for (const changed of [
      { ...inputs(), agentCandidateIds: new Set(['same']) },
      { ...inputs(), blockedIds: new Set(['same']) },
      { ...inputs(false), hideRepoBadge: true },
      { ...inputs(false), compactPreference: true }
    ]) {
      expect(resolveSidebarCardGeometry(plain, false, changed)).toBeNull()
    }
    expect(
      resolveSidebarCardGeometry(
        { ...plain, repo: { ...plain.repo, connectionId: 'ssh-host' } },
        false,
        inputs()
      )
    ).toBeNull()
    expect(
      resolveSidebarCardGeometry({ ...plain, hostContextLabel: 'host' }, false, inputs())
    ).toBeNull()
  })
  it('invalidates only changed occurrence measurements across known/unknown transitions and preserves numeric ownership on equivalent inputs', () => {
    const rows = [row('a', 0), row('b', 0)]
    const values = inputs()
    const build = (next: SidebarCardGeometryInputs) =>
      buildSidebarGeometry(rows, (row, expanded) => resolveSidebarCardGeometry(row, expanded, next))
    const known = build(values)
    const ledger = getSidebarGeometryLedger({ current: null })
    reconcileSidebarLedger(ledger, known, true, 300)
    publishSidebarObservation(ledger, known, 0, { prefix: 34.5, closing: null, width: 300 })
    publishSidebarObservation(ledger, known, 1, { prefix: 35, closing: null, width: 300 })
    expect(sidebarGeometryBoundaries(known, ledger.sizes)).toEqual([0, 40.5, 75.5])
    const equal = build({ ...values })
    expect(sidebarGeometryLayoutMatches(known, equal)).toBe(true)
    reconcileSidebarLedger(ledger, equal, true, 300)
    expect(ledger.sizes.size).toBe(2)
    const unknown = build({ ...values, agentCandidateIds: new Set(['a']) })
    expect(sidebarGeometryLayoutMatches(equal, unknown)).toBe(false)
    reconcileSidebarLedger(ledger, unknown, true, 300)
    expect(ledger.sizes.has(known.slots[0]!.key)).toBe(false)
    expect(ledger.sizes.get(known.slots[1]!.key)).toBe(35)
    publishSidebarObservation(ledger, unknown, 0, { prefix: 100, closing: null, width: 300 })
    reconcileSidebarLedger(ledger, known, true, 300)
    expect(ledger.sizes.has(known.slots[0]!.key)).toBe(false)
    expect(ledger.sizes.get(known.slots[1]!.key)).toBe(35)
  })
})
