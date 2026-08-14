// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'
import { WorkspaceCleanupFilterBar } from './workspace-cleanup-filter-bar'

afterEach(cleanup)

describe('WorkspaceCleanupFilterBar', () => {
  it('keeps size measurement out of the browse controls', () => {
    render(
      <WorkspaceCleanupFilterBar
        facetProps={{
          filters: createDefaultWorkspaceCleanupFilterState(),
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
        facetPanelOpen={false}
        onFacetPanelOpenChange={vi.fn()}
        activeFacetGroupCount={0}
        matchedCount={100}
        hasActiveFilters={false}
        gitEvidence={{ pendingCount: 0, totalCount: 0 }}
        onQueryChange={vi.fn()}
        onClearFilters={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Scan' })).toBeNull()
  })
})
