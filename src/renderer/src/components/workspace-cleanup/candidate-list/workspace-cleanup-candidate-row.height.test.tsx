// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeCandidate } from '../query/workspace-cleanup-candidate-state.test-fixture'
import { CandidateRow } from './workspace-cleanup-candidate-row'

vi.mock('@/store', () => ({ useAppStore: () => undefined }))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function render(overrides: { gitEvidencePending: boolean; dirty: boolean }): HTMLElement {
  const candidate = makeCandidate({
    git: {
      clean: !overrides.dirty,
      upstreamAhead: overrides.dirty ? 2 : 0,
      upstreamBehind: 0,
      checkedAt: overrides.gitEvidencePending ? null : 1
    },
    blockers: overrides.dirty ? ['dirty-files'] : []
  })
  const noop = (): void => {}
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root!.render(
      <TooltipProvider>
        <CandidateRow
          candidate={candidate}
          identity="id"
          expanded={false}
          gitEvidencePending={overrides.gitEvidencePending}
          last={false}
          lastActivityLabel="1d ago"
          reviewInfo={{ hasReview: false, label: null, state: null, provider: null } as never}
          repo={null}
          showHostLabel={false}
          showSizeColumn
          selected={false}
          onIgnore={noop}
          onRestore={noop}
          onRemove={noop}
          onToggleExpanded={noop}
          onToggleSelected={noop}
          onView={noop}
        />
      </TooltipProvider>
    )
  )
  return container
}

// jsdom has no layout, so assert the reservation itself: one fixed-height, fixed-width,
// non-wrapping slot holds every git state, so evidence swaps contents without resizing the row.
function gitSlotClass(container: HTMLElement): string | undefined {
  return container.querySelector('[data-workspace-cleanup-git-slot]')?.className
}

describe('CandidateRow git status slot', () => {
  it('uses the same fixed slot while checking, clean and dirty', () => {
    const checking = gitSlotClass(render({ gitEvidencePending: true, dirty: false }))
    act(() => root?.unmount())
    const clean = gitSlotClass(render({ gitEvidencePending: false, dirty: false }))
    act(() => root?.unmount())
    const dirty = gitSlotClass(render({ gitEvidencePending: false, dirty: true }))
    // A stray JS comment inside JSX would render as visible text.
    expect(document.body.textContent).not.toContain('//')
    expect(checking).toBeDefined()
    expect(clean).toBe(checking)
    expect(dirty).toBe(checking)
    expect(checking).toContain('overflow-hidden')
    expect(checking).toContain('h-5')
  })
})
