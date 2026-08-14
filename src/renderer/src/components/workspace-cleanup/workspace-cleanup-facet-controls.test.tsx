// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import {
  createDefaultWorkspaceCleanupFilterState,
  type WorkspaceCleanupFilterState
} from '../../../../shared/workspace-cleanup-filter-model'
import { WorkspaceCleanupGitReviewFacets } from './workspace-cleanup-git-review-facets'
import { WorkspaceCleanupLifecycleFacets } from './workspace-cleanup-lifecycle-facets'
import type {
  WorkspaceCleanupFacetCounts,
  WorkspaceCleanupFacetGroupProps,
  WorkspaceCleanupFacetOptions
} from './workspace-cleanup-facet-panel-model'

/** `Mock<T>` erases T's type parameter, so keep the generic call signature and add the spy API. */
type PatchMock = WorkspaceCleanupFacetGroupProps['onPatch'] & MockInstance

function createPatchMock(): PatchMock {
  return vi.fn()
}

let root: Root | null = null
let container: HTMLDivElement | null = null

const COUNTS: WorkspaceCleanupFacetCounts = {
  activity: 3,
  size: 4,
  status: 8,
  agent: 8,
  git: 2,
  review: 5,
  ticket: 8,
  context: 6,
  location: 8,
  safety: 7
}

const OPTIONS: WorkspaceCleanupFacetOptions = {
  workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
  hostIds: ['local', 'ssh:box'],
  repos: [
    { id: 'repo-1', label: 'Alpha' },
    { id: 'repo-2', label: 'Beta' }
  ],
  reviewProviders: ['github', 'gitlab']
}

function render(node: ReactNode): void {
  act(() => root?.render(node))
}

function control(label: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? null
}

/** React tracks the controlled value, so a bare `input.value =` is swallowed. */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) {
    return
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function renderFacets(filters: WorkspaceCleanupFilterState, onPatch: PatchMock): void {
  const props = { filters, counts: COUNTS, totalCount: 8, options: OPTIONS, onPatch }
  render(
    <>
      <WorkspaceCleanupLifecycleFacets {...props} />
      <WorkspaceCleanupGitReviewFacets {...props} />
    </>
  )
}

describe('workspace cleanup facet controls', () => {
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

  it('shows a per-facet match count for every group', () => {
    renderFacets(createDefaultWorkspaceCleanupFilterState(), createPatchMock())

    const counts = [...(container?.querySelectorAll('[data-facet-count]') ?? [])].map(
      (node) => node.textContent
    )
    expect(counts).toHaveLength(10)
    expect(counts).toContain('2/8')
    expect(counts).toContain('3/8')
  })

  it('takes a user-chosen idle threshold in days rather than a fixed enum', () => {
    const onPatch = createPatchMock()
    renderFacets(createDefaultWorkspaceCleanupFilterState(), onPatch)

    const input = control('Idle for at least') as HTMLInputElement | null
    expect(input?.type).toBe('number')
    act(() => typeInto(input, '17'))
    expect(onPatch).toHaveBeenCalledWith('activity', { idleMinDays: 17 })
  })

  it('multi-selects git states', () => {
    const onPatch = createPatchMock()
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.git.states = ['dirty']
    renderFacets(filters, onPatch)

    expect(control('Uncommitted changes')?.getAttribute('aria-checked')).toBe('true')
    act(() => control('Unpushed commits')?.click())
    expect(onPatch).toHaveBeenCalledWith('git', { states: ['dirty', 'unpushed'] })
  })

  it('offers the hosts and providers discovered in the fleet, not a hardcoded list', () => {
    renderFacets(createDefaultWorkspaceCleanupFilterState(), createPatchMock())

    expect(control('GitLab')).not.toBeNull()
    expect(container?.textContent).toContain('Alpha')
    expect(container?.textContent).toContain('In progress')
  })

  it('cycles a tri-state safety facet', () => {
    const onPatch = createPatchMock()
    renderFacets(createDefaultWorkspaceCleanupFilterState(), onPatch)

    act(() => container?.querySelector<HTMLElement>('[aria-label="Ignored: Only"]')?.click())
    expect(onPatch).toHaveBeenCalledWith('safety', { dismissed: 'only' })
  })

  it('labels blocker matching without exposing model tokens', () => {
    renderFacets(createDefaultWorkspaceCleanupFilterState(), createPatchMock())

    expect(control('Blocker match: Has any')).not.toBeNull()
    expect(control('Blocker match: Has none')).not.toBeNull()
    expect(container?.textContent).not.toContain('any-of')
    expect(container?.textContent).not.toContain('none-of')
  })

  it('toggles the unsized escape hatch for the opt-in space scan', () => {
    const onPatch = createPatchMock()
    renderFacets(createDefaultWorkspaceCleanupFilterState(), onPatch)

    const checkbox = control('Include unmeasured workspaces')
    expect(checkbox?.getAttribute('data-state')).toBe('checked')
    act(() => checkbox?.click())
    expect(onPatch).toHaveBeenCalledWith('size', { includeUnsized: false })
  })
})
