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
  it('keeps size measurement out of the browse controls', () => {
    renderFilterBar()

    expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull()
  })

  it('names an applied filter in the bar without opening the panel', () => {
    // The reported defect: a persisted idleMinDays the user never set. The bar already
    // read "Showing N of M", so only the cause was hidden.
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 20
    renderFilterBar(false, { filters, hasActiveFilters: true })

    expect(screen.getByRole('listitem').textContent).toContain('Idle 20d+')
  })

  it('clears one named filter from its chip', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 20
    const onClearAppliedFilter = vi.fn()
    renderFilterBar(false, { filters, hasActiveFilters: true, onClearAppliedFilter })

    screen.getByRole('button', { name: 'Remove filter Idle 20d+' }).click()

    expect(onClearAppliedFilter).toHaveBeenCalledTimes(1)
    expect(onClearAppliedFilter.mock.calls[0][0].id).toBe('activity.idleMinDays')
  })

  it('offers Clear filters in the bar, not only inside the panel', () => {
    renderFilterBar(false, { hasActiveFilters: true })

    expect(screen.getAllByRole('button', { name: /Clear filters/ }).length).toBeGreaterThan(0)
  })

  it('shows no chips and no Clear for a default profile', () => {
    renderFilterBar()

    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Clear filters/ })).toBeNull()
  })

  it('keeps the footer visible while the facet panel scrolls', () => {
    renderFilterBar(true)

    const content = document.querySelector('[data-slot="popover-content"]')
    const root = document.querySelector('[data-slot="scroll-area"]')
    expect(content?.className).toContain(
      'h-[min(471px,var(--radix-popover-content-available-height))]'
    )
    expect(root?.className).toContain('min-h-0 flex-1')
  })
})
