// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateRow } from './workspace-cleanup-candidate-row'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import { makeNamedFacets } from './workspace-cleanup-facet.test.fixture'

import type { WorkspaceCleanupFacets } from './workspace-cleanup-facets'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function renderRows(
  rows: readonly WorkspaceCleanupFacets[],
  onForgetLocally?: (candidate: WorkspaceCleanupFacets['candidate']) => void
): void {
  act(() =>
    root?.render(
      <WorkspaceCleanupCandidateList
        rows={rows}
        getRowKey={(row) => row.worktreeId}
        scrollElement={null}
        renderRow={(row, index) => (
          <CandidateRow
            key={row.identity}
            identity={row.identity}
            candidate={row.candidate}
            reviewInfo={row.review}
            repo={null}
            showHostLabel={false}
            showSizeColumn={row.sizeBytes !== null}
            expanded={false}
            last={index === rows.length - 1}
            lastActivityLabel="40d ago"
            sizeLabel={row.sizeBytes === null ? null : '4.00 MB'}
            workspaceStatusLabel={row.workspaceStatusLabel}
            selected={false}
            onIgnore={vi.fn()}
            onRemove={vi.fn()}
            onForgetLocally={onForgetLocally}
            onToggleExpanded={vi.fn()}
            onToggleSelected={vi.fn()}
            onView={vi.fn()}
          />
        )}
      />
    )
  )
}

describe('workspace cleanup flat list', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
  })

  it('offers local removal for a disconnected SSH row without making it selectable', () => {
    const onForgetLocally = vi.fn()
    const disconnected = makeNamedFacets('disconnected', {
      candidate: { blockers: ['ssh-disconnected'] }
    })

    renderRows([disconnected], onForgetLocally)

    expect(container?.querySelector('[aria-label^="Select disconnected"]')).toBeNull()
    const forgetButton = container?.querySelector<HTMLElement>('[aria-label="Remove from Orca"]')
    expect(forgetButton).not.toBeNull()
    act(() => forgetButton?.click())
    expect(onForgetLocally).toHaveBeenCalledWith(disconnected.candidate)
  })
})
