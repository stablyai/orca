// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import { getSelectedDeletableCandidates } from '../browse/workspace-cleanup-selection-model'
import {
  makeFacetCandidate as makeCandidate,
  makeFacets
} from '../query/workspace-cleanup-facet.test.fixture'
import { useWorkspaceCleanupGroupedRows } from './use-workspace-cleanup-grouped-rows'

const NONE: ReadonlySet<string> = new Set()
const UNCHECKED = { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }

const row = (name: string, overrides: Partial<WorkspaceCleanupCandidate> = {}) =>
  makeCandidate({ worktreeId: `repo-1::/repo/${name}`, displayName: name, ...overrides })
const facet = (candidate: WorkspaceCleanupCandidate): WorkspaceCleanupFacets =>
  makeFacets({ candidate })
const names = (rows: readonly WorkspaceCleanupFacets[]) => rows.map((r) => r.candidate.displayName)

type Props = { candidates: WorkspaceCleanupCandidate[]; scanning: boolean }
function mount(initial: Props, selectedIds: ReadonlySet<string>) {
  return renderHook(
    ({ candidates, scanning }: Props) =>
      useWorkspaceCleanupGroupedRows({
        rows: candidates.map(facet),
        candidates,
        open: true,
        scanning,
        gitEvidence: { pendingWorktreeIds: NONE, totalCount: 1 },
        selectedIds,
        deletingIdentities: NONE
      }),
    { initialProps: initial }
  )
}

describe('selection through Refresh', () => {
  it('keeps selected rows visible and counted while their new evidence is unsettled', () => {
    const rows = ['a', 'b', 'c', 'd'].map((name) => row(name))
    const selected = new Set(rows.slice(0, 3).map(getWorkspaceCleanupCandidateIdentity))
    const { result, rerender } = mount({ candidates: rows, scanning: false }, selected)
    expect(names(result.current.rowsByGroup['nothing-local'])).toEqual(['a', 'b', 'c', 'd'])

    act(() => result.current.resetGroups())
    // The refresh scan returns every row with git still unknown.
    const unsettled = rows.map((r) => ({ ...r, git: UNCHECKED }))
    rerender({ candidates: unsettled, scanning: true })
    rerender({ candidates: unsettled, scanning: false })
    rerender({ candidates: unsettled, scanning: false })

    const visible = [
      ...result.current.rowsByGroup['nothing-local'],
      ...result.current.rowsByGroup['local-files']
    ]
    expect(names(visible).sort()).toEqual(['a', 'b', 'c', 'd'])
    // Selection counts and confirm read the same visible rows.
    const toConfirm = getSelectedDeletableCandidates(
      unsettled.map(facet).filter((r) => result.current.visibleIdentities.has(r.identity)),
      selected,
      NONE
    )
    expect(toConfirm.map((c) => c.displayName).sort()).toEqual(['a', 'b', 'c'])
    expect(result.current.groupSummaries['nothing-local'].selectedCount).toBe(3)
  })

  it('hides an unselected row until its evidence settles', () => {
    const rows = ['a', 'b'].map((name) => row(name))
    const selected = new Set([getWorkspaceCleanupCandidateIdentity(rows[0])])
    const { result, rerender } = mount({ candidates: rows, scanning: false }, selected)
    act(() => result.current.resetGroups())
    const waiting = rows.map((r) => ({ ...r, git: { ...UNCHECKED } }))
    rerender({ candidates: waiting, scanning: true })
    rerender({ candidates: waiting, scanning: false })
    const shown = [
      ...result.current.rowsByGroup['nothing-local'],
      ...result.current.rowsByGroup['local-files']
    ]
    expect(names(shown)).toContain('a')
    expect(names(shown)).toContain('b')
  })
})

describe('a new blocker on a shown row', () => {
  it('shows live data and the cannot-delete reason at once, and drops it from the confirmable selection', () => {
    const a = row('a')
    const selected = new Set([getWorkspaceCleanupCandidateIdentity(a)])
    const { result, rerender } = mount({ candidates: [a], scanning: false }, selected)
    expect(result.current.getRowGroup(facet(a))).toBe('nothing-local')

    const blocked = row('a', { blockers: ['ssh-disconnected'] })
    rerender({ candidates: [blocked], scanning: false })
    const [shown] = result.current.rowsByGroup['nothing-local']
    expect(shown.candidate.blockers).toContain('ssh-disconnected')
    expect(result.current.getRowGroup(shown)).toBe('cannot-delete')
    expect(getSelectedDeletableCandidates([facet(blocked)], selected, NONE)).toEqual([])
  })
})
