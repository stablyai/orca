// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT
} from '../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'

const holders = vi.hoisted(() => ({ state: null as AppState | null }))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T => {
    if (!holders.state) {
      throw new Error('Missing test state')
    }
    return selector(holders.state)
  }
}))

import { useWorkspaceCleanupFacetRows } from './use-workspace-cleanup-facet-rows'

function makeState(): AppState {
  return {
    worktreesByRepo: {},
    hostedReviewCache: {},
    repos: [],
    settings: {},
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    lastVisitedAtByWorktreeId: {},
    agentStatusByPaneKey: {},
    tabsByWorktree: {},
    workspaceCleanupDismissals: {},
    workspaceSpaceAnalysis: null,
    workspaceSpaceMeasurements: []
  } as unknown as AppState
}

describe('useWorkspaceCleanupFacetRows', () => {
  beforeEach(() => {
    holders.state = makeState()
  })

  it('keeps review joins stable during unrelated agent-status churn', () => {
    const candidates = [makeFacetCandidate()]
    const filters = createDefaultWorkspaceCleanupFilterState()
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates,
        filters,
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000
      })
    )
    const reviewIndex = view.result.current.reviewInfoByWorktreeId

    holders.state = { ...holders.state!, agentStatusByPaneKey: {} }
    view.rerender()

    expect(view.result.current.reviewInfoByWorktreeId).toBe(reviewIndex)
  })

  it('projects streamed size measurements before the full scan completes', () => {
    const candidates = [makeFacetCandidate()]
    const filters = createDefaultWorkspaceCleanupFilterState()
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates,
        filters,
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000
      })
    )
    expect(view.result.current.rows[0]?.sizeBytes).toBeNull()

    holders.state = {
      ...holders.state!,
      workspaceSpaceMeasurements: [
        { worktreeId: candidates[0]!.worktreeId, status: 'ok', sizeBytes: 4_096 }
      ]
    }
    view.rerender()

    expect(view.result.current.rows[0]?.sizeBytes).toBe(4_096)
    expect(view.result.current.measuredSizeCount).toBe(1)
  })

  it('includes folder repositories discovered from cleanup candidates', () => {
    const candidate = makeFacetCandidate({ repoId: 'folder-1', repoName: 'Loose files' })
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates: [candidate],
        filters: createDefaultWorkspaceCleanupFilterState(),
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000
      })
    )

    expect(view.result.current.options.repos).toEqual([{ id: 'folder-1', label: 'Loose files' }])
  })

  it('keeps facet identity for untouched rows when a tick replaces one candidate', () => {
    const stable = makeFacetCandidate()
    const replaced = makeFacetCandidate({ worktreeId: 'repo-1::/b' })
    const filters = createDefaultWorkspaceCleanupFilterState()
    const view = renderHook(
      ({ current }) =>
        useWorkspaceCleanupFacetRows({
          candidates: current,
          filters,
          sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
          now: 1_700_000_000_000
        }),
      { initialProps: { current: [stable, replaced] } }
    )
    const stableFacet = view.result.current.rows.find((row) => row.worktreeId === stable.worktreeId)

    view.rerender({
      current: [stable, makeFacetCandidate({ worktreeId: 'repo-1::/b', displayName: 'renamed' })]
    })

    expect(view.result.current.rows.find((row) => row.worktreeId === stable.worktreeId)).toBe(
      stableFacet
    )
    expect(
      view.result.current.rows.find((row) => row.worktreeId === 'repo-1::/b')?.displayName
    ).toBe('renamed')
  })

  it('offers no facet options while the filter panel is closed', () => {
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates: [makeFacetCandidate()],
        filters: createDefaultWorkspaceCleanupFilterState(),
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000,
        facetPanelOpen: false
      })
    )

    expect(view.result.current.options.repos).toEqual([])
  })

  it('projects same-id streamed sizes only onto their owning hosts', () => {
    const worktreeId = 'repo-1::/repo/alpha'
    const candidates = [
      makeFacetCandidate({ worktreeId, displayName: 'local', executionHostId: 'local' }),
      makeFacetCandidate({
        worktreeId,
        displayName: 'remote',
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ]
    holders.state = {
      ...holders.state!,
      workspaceSpaceMeasurements: [
        { worktreeId, executionHostId: 'ssh:builder', status: 'ok', sizeBytes: 4_096 }
      ]
    }
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates,
        filters: createDefaultWorkspaceCleanupFilterState(),
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000
      })
    )

    expect(
      view.result.current.rows.find((row) => row.displayName === 'local')?.sizeBytes
    ).toBeNull()
    expect(view.result.current.rows.find((row) => row.displayName === 'remote')?.sizeBytes).toBe(
      4_096
    )
    expect([...view.result.current.facetMatchedIdentities]).toEqual([
      getWorkspaceCleanupCandidateIdentity(candidates[0]!),
      getWorkspaceCleanupCandidateIdentity(candidates[1]!)
    ])
  })
})
