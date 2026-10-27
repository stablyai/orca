// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'
import type { WorkspaceCleanupAppliedFilter } from '../../../../shared/workspace-cleanup-applied-filters'
import { WorkspaceCleanupFilterBar } from './workspace-cleanup-filter-bar'

afterEach(cleanup)

function renderFilterBar(
  facetPanelOpen = false,
  overrides: {
    filters?: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>
    hasActiveFilters?: boolean
    onClearAppliedFilter?: (filter: WorkspaceCleanupAppliedFilter) => void
    onClearFilters?: () => void
  } = {}
): void {
  render(
    <WorkspaceCleanupFilterBar
      facetProps={{
        filters: overrides.filters ?? createDefaultWorkspaceCleanupFilterState(),
        counts: {
          activity: 0,
          size: 0,
          status: 0,
          agent: 0,
          git: 0,
          review: 0,
          ticket: 0,
          context: 0,
          location: 0,
          safety: 0
        },
        totalCount: 100,
        options: { workspaceStatuses: [], hostIds: [], repos: [], reviewProviders: [] },
        onPatch: vi.fn()
      }}
      facetPanelOpen={facetPanelOpen}
      onFacetPanelOpenChange={vi.fn()}
      activeFacetGroupCount={0}
      matchedCount={100}
      hasActiveFilters={overrides.hasActiveFilters ?? false}
      gitEvidence={{ pendingCount: 0, totalCount: 0 }}
      onQueryChange={vi.fn()}
      onClearFilters={overrides.onClearFilters ?? vi.fn()}
      onClearAppliedFilter={overrides.onClearAppliedFilter ?? vi.fn()}
    />
  )
}

describe('WorkspaceCleanupFilterBar', () => {
  it('clears one named filter from its chip', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 20
    const onClearAppliedFilter = vi.fn()
    renderFilterBar(false, { filters, hasActiveFilters: true, onClearAppliedFilter })

    screen.getByRole('button', { name: 'Remove filter Idle 20d+' }).click()

    expect(onClearAppliedFilter).toHaveBeenCalledTimes(1)
    expect(onClearAppliedFilter.mock.calls[0][0].id).toBe('activity.idleMinDays')
  })
})
