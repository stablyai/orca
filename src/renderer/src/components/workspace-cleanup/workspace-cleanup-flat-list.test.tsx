// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT,
  type WorkspaceCleanupFilterState
} from '../../../../shared/workspace-cleanup-filter-model'
import { CandidateRow } from './workspace-cleanup-candidate-row'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import { FACET_NOW, makeNamedFacets } from './workspace-cleanup-facet.test.fixture'
import { getWorkspaceCleanupHostIdentity } from './workspace-cleanup-host-identity'
import { runWorkspaceCleanupQuery } from './workspace-cleanup-query'
import type { WorkspaceCleanupFacets } from './workspace-cleanup-facets'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

// One row per bucket the retired tab partition used to hide behind a tab.
const FLEET: WorkspaceCleanupFacets[] = [
  makeNamedFacets('ready-one', {
    candidate: { tier: 'ready' },
    sizeBytes: 4 * 1024 * 1024
  }),
  makeNamedFacets('needs-review', { candidate: { tier: 'review' } }),
  makeNamedFacets('protected-one', {
    candidate: {
      tier: 'protected',
      blockers: ['pinned'],
      selectedByDefault: false
    }
  }),
  makeNamedFacets('ignored-one', { dismissed: true })
]

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

function renderedNames(): string[] {
  // Buttons share `text-sm font-medium`, so scope to the row's name span.
  return [...(container?.querySelectorAll('span.truncate.text-sm.font-medium') ?? [])].map(
    (node) => node.textContent ?? ''
  )
}

function query(filters: WorkspaceCleanupFilterState = createDefaultWorkspaceCleanupFilterState()) {
  return runWorkspaceCleanupQuery(
    FLEET,
    { filters, sort: DEFAULT_WORKSPACE_CLEANUP_SORT },
    FACET_NOW
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

  it('renders every tier in one list rather than per-tab groups', () => {
    const result = query()

    renderRows(result.rows)

    expect(result.totalCount).toBe(FLEET.length)
    expect(result.matchedCount).toBe(FLEET.length)
    expect(renderedNames()).toEqual(
      expect.arrayContaining(['ready-one', 'needs-review', 'protected-one', 'ignored-one'])
    )
  })

  it('switches the visible rows when filters are applied', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.safety.dismissed = 'exclude'
    renderRows(query(filters).rows)
    expect(renderedNames()).not.toContain('ignored-one')

    filters.safety.dismissed = 'only'
    renderRows(query(filters).rows)
    expect(renderedNames()).toEqual(['ignored-one'])
  })

  it('lets select-all include pinned label rows', () => {
    expect(query().selectableIdentities).toContain(
      getWorkspaceCleanupHostIdentity('local', 'repo-1::/repo/protected-one')
    )
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

  it('shows status and disk-size facts without expanding a row', () => {
    renderRows(query().rows)

    expect(container?.textContent).toContain('In progress')
    expect(container?.textContent).toContain('4.00 MB')
    expect(container?.textContent).toContain('Not measured')
    const sizedRows = [...(container?.querySelectorAll('[aria-label^="Size on disk"]') ?? [])]
    expect(sizedRows).toHaveLength(FLEET.length)
  })
})
