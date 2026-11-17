// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { makeCandidate } from '../query/workspace-cleanup-candidate-state.test-fixture'
import type { WorkspaceCleanupReviewInfo } from '../candidate-evidence/workspace-cleanup-review-lookup'
import { CandidateRow } from './workspace-cleanup-candidate-row'

vi.mock('@/store', () => ({ useAppStore: () => undefined }))

const NO_REVIEW: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function render(candidate = makeCandidate(), group: WorkspaceCleanupGroup): HTMLElement {
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
          group={group}
          expanded={false}
          last={false}
          lastActivityLabel="1d ago"
          reviewInfo={NO_REVIEW}
          repo={null}
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

// happy-dom has no layout, so assert the reservation itself: the second line is one
// fixed-height, non-wrapping, clipped line whatever it says, so it can never grow the row.
function noticeLineClass(container: HTMLElement): string | undefined {
  return container.querySelector('div.mt-0\\.5.h-5')?.className
}

describe('CandidateRow second line', () => {
  it('is one fixed, non-wrapping line for every notice', () => {
    const longNames = Array.from({ length: 40 }, (_, i) => `ignored-${i}.log`)
    const dirty = noticeLineClass(
      render(
        makeCandidate({
          git: {
            clean: false,
            upstreamAhead: 0,
            upstreamBehind: 0,
            checkedAt: 1,
            atRiskLocalFiles: { count: longNames.length, samplePaths: longNames, complete: true }
          },
          blockers: ['dirty-files', 'ignored-files']
        }),
        'local-files'
      )
    )
    act(() => root?.unmount())
    const blocked = noticeLineClass(
      render(makeCandidate({ blockers: ['main-worktree'] }), 'cannot-delete')
    )
    // A stray JS comment inside JSX would render as visible text.
    expect(document.body.textContent).not.toContain('//')
    expect(dirty).toBeDefined()
    expect(blocked).toBe(dirty)
    expect(dirty).toContain('h-5')
    expect(dirty).toContain('flex-nowrap')
    expect(dirty).toContain('overflow-hidden')
  })

  it('renders no second line when there is nothing to say', () => {
    const clean = render(makeCandidate(), 'nothing-local')
    expect(noticeLineClass(clean)).toBeUndefined()
  })
})
