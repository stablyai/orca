// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateRow } from './workspace-cleanup-candidate-row'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

describe('CandidateRow', () => {
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

  it('hides selection and remove controls while the workspace is already deleting', () => {
    const candidate = makeCandidate()

    act(() => {
      root?.render(
        <CandidateRow
          candidate={candidate}
          expanded={false}
          last
          lastActivityLabel="1d ago"
          removing
          reviewInfo={{
            hasReview: false,
            label: null,
            provider: null,
            state: null,
            title: null
          }}
          selected
          onIgnore={vi.fn()}
          onRemove={vi.fn()}
          onToggleExpanded={vi.fn()}
          onToggleSelected={vi.fn()}
          onView={vi.fn()}
        />
      )
    })

    expect(container?.querySelector(`[aria-label="Select ${candidate.displayName}"]`)).toBeNull()
    expect(container?.querySelector(`[aria-label="Remove ${candidate.displayName}"]`)).toBeNull()
  })
})
