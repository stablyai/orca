// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT
} from '../../../../shared/workspace-cleanup-filter-model'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type * as FacetModule from './workspace-cleanup-facets'
import type * as QueryModule from './workspace-cleanup-query'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'

const holders = vi.hoisted(() => ({ state: null as AppState | null }))
const counts = vi.hoisted(() => ({ facetCounts: 0, measured: 0, queries: 0 }))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: AppState) => T): T => {
    if (!holders.state) {
      throw new Error('Missing test state')
    }
    return selector(holders.state)
  }
}))

vi.mock('./workspace-cleanup-facets', async (importOriginal) => {
  const actual = await importOriginal<typeof FacetModule>()
  return {
    ...actual,
    countWorkspaceCleanupMeasuredRows: (
      ...args: Parameters<typeof actual.countWorkspaceCleanupMeasuredRows>
    ) => {
      counts.measured += 1
      return actual.countWorkspaceCleanupMeasuredRows(...args)
    }
  }
})

vi.mock('./workspace-cleanup-query', async (importOriginal) => {
  const actual = await importOriginal<typeof QueryModule>()
  return {
    ...actual,
    countWorkspaceCleanupFacetMatches: (
      ...args: Parameters<typeof actual.countWorkspaceCleanupFacetMatches>
    ) => {
      counts.facetCounts += 1
      return actual.countWorkspaceCleanupFacetMatches(...args)
    },
    runWorkspaceCleanupQuery: (...args: Parameters<typeof actual.runWorkspaceCleanupQuery>) => {
      counts.queries += 1
      return actual.runWorkspaceCleanupQuery(...args)
    }
  }
})

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

describe('useWorkspaceCleanupFacetRows hot paths', () => {
  beforeEach(() => {
    holders.state = makeState()
    counts.facetCounts = 0
    counts.measured = 0
    counts.queries = 0
  })

  it('does only the query work when the user types', () => {
    const candidates = [makeFacetCandidate()]
    const filters = createDefaultWorkspaceCleanupFilterState()
    const view = renderHook(
      ({ currentFilters }) =>
        useWorkspaceCleanupFacetRows({
          candidates,
          filters: currentFilters,
          sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
          now: 1_700_000_000_000
        }),
      { initialProps: { currentFilters: filters } }
    )
    const initialCounts = { ...counts }
    const reviewIndex = view.result.current.reviewInfoByWorktreeId

    view.rerender({ currentFilters: { ...filters, query: 'alpha' } })

    expect(counts.queries).toBeGreaterThan(initialCounts.queries)
    expect(counts.facetCounts).toBe(initialCounts.facetCounts)
    expect(counts.measured).toBe(initialCounts.measured)
    expect(view.result.current.reviewInfoByWorktreeId).toBe(reviewIndex)
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

  it('does not rebuild facets for count-only size progress', () => {
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
    const initialCounts = { ...counts }

    holders.state = {
      ...holders.state!,
      workspaceSpaceScanProgress: {
        scanId: 'scan-1',
        state: 'running',
        startedAt: 1,
        updatedAt: 2,
        totalRepoCount: 1,
        scannedRepoCount: 0,
        totalWorktreeCount: 100,
        scannedWorktreeCount: 20,
        currentRepoDisplayName: 'Repo',
        currentWorktreeDisplayName: 'alpha'
      }
    }
    view.rerender()

    expect(counts).toEqual(initialCounts)
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

  it('skips every downstream pass when a streaming tick changes no candidate', () => {
    const candidates = [makeFacetCandidate(), makeFacetCandidate({ worktreeId: 'repo-1::/b' })]
    const filters = createDefaultWorkspaceCleanupFilterState()
    const view = renderHook(
      ({ current }) =>
        useWorkspaceCleanupFacetRows({
          candidates: current,
          filters,
          sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
          now: 1_700_000_000_000
        }),
      { initialProps: { current: candidates } }
    )
    const initialCounts = { ...counts }
    const matched = view.result.current.facetMatchedIdentities
    const rows = view.result.current.rows

    // A no-op progress tick delivers a fresh array of the same candidate objects.
    view.rerender({ current: [...candidates] })

    expect(counts).toEqual(initialCounts)
    expect(view.result.current.rows).toBe(rows)
    expect(view.result.current.facetMatchedIdentities).toBe(matched)
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

  it('skips facet count and option passes while the filter panel is closed', () => {
    const view = renderHook(() =>
      useWorkspaceCleanupFacetRows({
        candidates: [makeFacetCandidate()],
        filters: createDefaultWorkspaceCleanupFilterState(),
        sort: DEFAULT_WORKSPACE_CLEANUP_SORT,
        now: 1_700_000_000_000,
        facetPanelOpen: false
      })
    )

    expect(counts.facetCounts).toBe(0)
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
