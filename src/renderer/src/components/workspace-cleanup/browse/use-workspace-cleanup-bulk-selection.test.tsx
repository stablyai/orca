// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import { makeCandidate } from '../query/workspace-cleanup-candidate-state.test-fixture'
import { useWorkspaceCleanupBulkSelection } from './use-workspace-cleanup-bulk-selection'

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function candidate(name: string, blockers: WorkspaceCleanupCandidate['blockers'] = []) {
  return makeCandidate({ worktreeId: `repo-1::/repo/${name}`, displayName: name, blockers })
}
function facet(c: WorkspaceCleanupCandidate): WorkspaceCleanupFacets {
  return {
    candidate: c,
    identity: getWorkspaceCleanupCandidateIdentity(c),
    // Mirrors the facet builder: dismissed rows are excluded from select-all.
    isSelectable: !c.blockers.includes('dismissed')
  } as WorkspaceCleanupFacets
}

type Harness = {
  api: ReturnType<typeof useWorkspaceCleanupBulkSelection>
  selected: () => string[]
  select: (...names: string[]) => void
  render: (candidates: WorkspaceCleanupCandidate[]) => void
}

function mount(initial: WorkspaceCleanupCandidate[]): Harness {
  let candidates = initial
  const out = {} as Harness
  let selectedIds = new Set<string>()
  function Probe(): null {
    const [selected, setSelected] = useState<Set<string>>(new Set())
    selectedIds = selected
    out.select = (...names) =>
      act(() =>
        setSelected(new Set(names.map((n) => getWorkspaceCleanupCandidateIdentity(candidate(n)))))
      )
    out.api = useWorkspaceCleanupBulkSelection({
      rows: candidates.map(facet),
      selectedIds: selected,
      setSelectedIds: setSelected,
      deletingIdentities: new Set(),
      removalInFlight: false,
      evidencedCandidates: candidates,
      candidateIdentities: new Set(candidates.map(getWorkspaceCleanupCandidateIdentity)),
      loading: false
    })
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() => root!.render(<Probe />))
  out.selected = () => [...selectedIds]
  out.render = (next) => {
    candidates = next
    act(() => root!.render(<Probe />))
  }
  return out
}

const id = (name: string): string => getWorkspaceCleanupCandidateIdentity(candidate(name))

describe('useWorkspaceCleanupBulkSelection', () => {
  it('un-checks a row that becomes unselectable and keeps it unchecked when it clears', () => {
    const h = mount([candidate('a'), candidate('b')])
    h.select('a', 'b')
    expect(h.selected()).toHaveLength(2)
    h.render([candidate('a'), candidate('b', ['ssh-disconnected'])])
    expect(h.selected()).toEqual([id('a')])
    h.render([candidate('a'), candidate('b')])
    expect(h.selected()).toEqual([id('a')])
  })

  it('counts and select-all act on displayed rows only', () => {
    const h = mount([candidate('a'), candidate('b'), candidate('c', ['ssh-disconnected'])])
    expect(h.api.bulkSelectableCount).toBe(2)
    act(() => h.api.toggleSelectAll(true))
    expect(h.selected().sort()).toEqual([id('a'), id('b')].sort())
    expect(h.api.selectedBulkCount).toBe(2)
  })

  it('select-all never adds an ignored row; a manually ticked one counts and clears', () => {
    const h = mount([candidate('a'), candidate('ig', ['dismissed'])])
    act(() => h.api.toggleSelectAll(true))
    expect(h.selected()).toEqual([id('a')])
    h.select('ig')
    // Only an ignored row is ticked: the header is "mixed" (displayed count > 0, bulk count 0).
    expect(h.api.selectedDisplayedCount).toBe(1)
    expect(h.api.selectedBulkCount).toBe(0)
    act(() => h.api.toggleSelectAll(false))
    expect(h.selected()).toEqual([])
  })

  it('clearing removes every displayed check, ignored rows included', () => {
    const h = mount([candidate('a'), candidate('ig', ['dismissed'])])
    h.select('a', 'ig')
    act(() => h.api.toggleSelectAll(false))
    expect(h.selected()).toEqual([])
  })
})
