// @vitest-environment happy-dom
import { useMemo } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { getSelectedDeletableCandidates } from '../browse/workspace-cleanup-selection-model'
import { useWorkspaceCleanupHeldRows } from '../candidate-list/use-workspace-cleanup-row-order'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import {
  makeFacetCandidate as makeCandidate,
  makeFacets
} from '../query/workspace-cleanup-facet.test.fixture'
import { useWorkspaceCleanupGroupedRows } from './use-workspace-cleanup-grouped-rows'

// Both list hooks wired the way the dialog wires them: the held order reads the FILTERED rows
// plus every live row, and the grouping layer reads the held rows.

const NONE: ReadonlySet<string> = new Set()
const UNCHECKED = { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
const CLEAN = { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }
const DIRTY = { clean: false, dirtyFileCount: 2, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 2 }

const make = (name: string, overrides: Partial<WorkspaceCleanupCandidate> = {}) =>
  makeCandidate({
    worktreeId: `repo-1::/repo/${name}`,
    displayName: name,
    git: CLEAN,
    ...overrides
  })
const dirty = (candidate: WorkspaceCleanupCandidate) => ({
  ...candidate,
  git: DIRTY,
  blockers: [...candidate.blockers, 'dirty-files' as const]
})
const unchecked = (candidate: WorkspaceCleanupCandidate) => ({ ...candidate, git: UNCHECKED })
const facet = (candidate: WorkspaceCleanupCandidate): WorkspaceCleanupFacets =>
  makeFacets({ candidate })
const names = (rows: readonly WorkspaceCleanupFacets[]) => rows.map((r) => r.candidate.displayName)
const pendingFor = (...candidates: WorkspaceCleanupCandidate[]) =>
  new Set(candidates.map((candidate) => candidate.worktreeId))

/** The user's active filter: hide rows known to have uncommitted changes. */
const HIDE_UNCOMMITTED = (candidate: WorkspaceCleanupCandidate) => candidate.git.clean !== false
const HIDE_UNCOMMITTED_KEY = 'activity:desc:{"git":"no-uncommitted"}'

type Props = {
  candidates: WorkspaceCleanupCandidate[]
  matches: (candidate: WorkspaceCleanupCandidate) => boolean
  filterKey: string
  loading: boolean
  pending: ReadonlySet<string>
  selectedIds: ReadonlySet<string>
}

function useDialogList(props: Props) {
  const allRows = useMemo(() => props.candidates.map(facet), [props.candidates])
  const { matches } = props
  const liveRows = useMemo(
    () => allRows.filter((row) => matches(row.candidate)),
    [allRows, matches]
  )
  const liveRowByIdentity = useMemo(
    () => new Map(allRows.map((row) => [row.identity, row])),
    [allRows]
  )
  const { rows } = useWorkspaceCleanupHeldRows({
    liveRows,
    liveRowByIdentity,
    resetKey: props.filterKey,
    filterKey: props.filterKey,
    open: true,
    loading: props.loading,
    gitChecking: props.pending.size > 0,
    pinnedIdentities: props.selectedIds,
    shouldResortAtSettle: () => props.selectedIds.size === 0
  })
  const grouped = useWorkspaceCleanupGroupedRows({
    rows,
    candidates: props.candidates,
    open: true,
    scanning: props.loading,
    gitEvidence: { pendingWorktreeIds: props.pending, totalCount: props.pending.size },
    selectedIds: props.selectedIds,
    deletingIdentities: NONE
  })
  // Footer count and confirm read live rows, limited to what a card shows (as the dialog does).
  const confirm = getSelectedDeletableCandidates(
    rows.filter((row) => grouped.visibleIdentities.has(row.identity)),
    props.selectedIds,
    NONE
  )
  return { ...grouped, confirm }
}

function mountWithBSelected() {
  const [a, b, c] = ['a', 'b', 'c'].map((name) => make(name))
  const selectedIds: ReadonlySet<string> = new Set([getWorkspaceCleanupCandidateIdentity(b)])
  const initial: Props = {
    candidates: [a, b, c],
    matches: HIDE_UNCOMMITTED,
    filterKey: HIDE_UNCOMMITTED_KEY,
    loading: false,
    pending: NONE,
    selectedIds
  }
  const hook = renderHook((props: Props) => useDialogList(props), { initialProps: initial })
  let props = initial
  const update = (patch: Partial<Props>) => {
    props = { ...props, ...patch }
    hook.rerender(props)
  }
  return { ...hook, update, a, b, c }
}

describe('a selected row that stops matching the filter', () => {
  it('keeps its slot, count and live confirm through Refresh with pending git reads', () => {
    const { result, update, a, b, c } = mountWithBSelected()
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'b', 'c'])

    // Late evidence: b has uncommitted files, so it no longer matches the active filter.
    update({ candidates: [a, dirty(b), c] })
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'b', 'c'])

    // Refresh: the held order resets at scan start while the old scan is still on screen.
    act(() => result.current.resetGroups())
    update({ loading: true })
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'b', 'c'])
    expect(result.current.groupSummaries['nothing-local'].selectedCount).toBe(1)

    // The new scan lands with every git read still pending.
    const fresh = [unchecked(a), unchecked(b), unchecked(c)]
    update({ candidates: fresh, pending: pendingFor(a, b, c) })
    update({ loading: false })
    expect(names(result.current.rowsByGroup['nothing-local'])).toContain('b')
    expect(result.current.groupSummaries['nothing-local'].selectedCount).toBe(1)

    // a and c settle first; b keeps its old snapshot and its slot until its own read lands.
    update({ candidates: [a, unchecked(b), c], pending: pendingFor(b) })
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'b', 'c'])
    expect(result.current.rowsByGroup['nothing-local'][1].candidate.git.clean).toBe(true)

    // b settles dirty: it updates in place (same card, same slot) and stays selected.
    update({ candidates: [a, dirty(b), c], pending: NONE })
    const shown = result.current.rowsByGroup['nothing-local']
    expect(names(shown)).toEqual(['a', 'b', 'c'])
    expect(shown[1].candidate.git.clean).toBe(false)
    expect(result.current.groupSummaries['nothing-local'].selectedCount).toBe(1)
    // Confirm gets the live row, so it lists b under "Local files will be lost".
    expect(result.current.confirm).toHaveLength(1)
    expect(result.current.confirm[0].git.clean).toBe(false)
    expect(result.current.confirm[0].blockers).toContain('dirty-files')
  })

  it('drops a selected row that no longer exists', () => {
    const { result, update, a, b, c } = mountWithBSelected()
    update({ candidates: [a, dirty(b), c] })
    act(() => result.current.resetGroups())
    update({ loading: true })
    update({ candidates: [unchecked(a), unchecked(c)], pending: pendingFor(a, c) })
    update({ loading: false })
    update({ candidates: [a, c], pending: NONE })
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'c'])
    expect(result.current.confirm).toEqual([])
  })

  it('shows a new blocker on the kept row live and leaves it out of confirm', () => {
    const { result, update, a, b, c } = mountWithBSelected()
    update({ candidates: [a, dirty(b), c] })
    act(() => result.current.resetGroups())
    update({ loading: true })
    update({ candidates: [unchecked(a), unchecked(b), unchecked(c)], pending: pendingFor(a, b, c) })
    update({ loading: false })
    const blocked = { ...dirty(b), blockers: [...dirty(b).blockers, 'ssh-disconnected' as const] }
    update({ candidates: [a, blocked, c], pending: NONE })
    const shown = result.current.rowsByGroup['nothing-local']
    expect(names(shown)).toEqual(['a', 'b', 'c'])
    expect(shown[1].candidate.blockers).toContain('ssh-disconnected')
    expect(result.current.getRowGroup(shown[1])).toBe('cannot-delete')
    expect(result.current.confirm).toEqual([])
  })

  it('is not carried across the user changing the filter', () => {
    const { result, update, a, b, c } = mountWithBSelected()
    update({ candidates: [a, dirty(b), c] })
    // An explicit filter change re-derives the list; the dialog prunes the selection with a notice.
    update({
      matches: (candidate) => HIDE_UNCOMMITTED(candidate) && candidate.displayName !== 'b',
      filterKey: `${HIDE_UNCOMMITTED_KEY}:query=not-b`
    })
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'c'])
  })
})
