// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { SourceControlActionRepoOverrideNote } from './SourceControlActionRepoOverrideNote'
import type { SourceControlActionRecipeOverrideSummary } from '@/lib/source-control-launch-agent-selection'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderNote(
  summary: SourceControlActionRecipeOverrideSummary,
  onReviewRepo = vi.fn()
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <SourceControlActionRepoOverrideNote summary={summary} onReviewRepo={onReviewRepo} />
      </TooltipProvider>
    )
  })
}

describe('SourceControlActionRepoOverrideNote', () => {
  it('renders nothing when no repo overrides the action', () => {
    renderNote({ count: 0, overrides: [] })
    expect(container.textContent).toBe('')
  })

  it('shows the singular count when one repo overrides the action', () => {
    renderNote({
      count: 1,
      overrides: [{ repoId: 'r1', repoName: 'App', fields: ['commandTemplate'] }]
    })
    expect(container.textContent).toContain("Global saves won't change 1 repository")
    expect(container.textContent).toContain('Review')
  })

  it('shows the plural count when several repos override the action', () => {
    renderNote({
      count: 2,
      overrides: [
        { repoId: 'r1', repoName: 'App', fields: ['agent'] },
        { repoId: 'r2', repoName: 'Web', fields: ['agentArgs'] }
      ]
    })
    expect(container.textContent).toContain("Global saves won't change 2 repositories")
    expect(container.textContent).toContain('Review first')
  })

  it('shows a "+N more" note when overrides exceed the visible limit', async () => {
    renderNote({
      count: 6,
      overrides: Array.from({ length: 6 }, (_, index) => ({
        repoId: `r${index}`,
        repoName: `Repo ${index}`,
        fields: ['commandTemplate']
      }))
    })

    // The overflow note lives in the tooltip content, only mounted once Radix
    // opens the tooltip — drive its pointer-move open path and flush the timer.
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]')
    await act(async () => {
      trigger?.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(document.body.textContent).toContain('+1 more')
  })

  it('opens the first repo override from the review action', () => {
    const onReviewRepo = vi.fn()
    renderNote(
      {
        count: 2,
        overrides: [
          { repoId: 'r1', repoName: 'App', fields: ['agent'] },
          { repoId: 'r2', repoName: 'Web', fields: ['agentArgs'] }
        ]
      },
      onReviewRepo
    )

    act(() => {
      container.querySelector('button')?.click()
    })

    expect(onReviewRepo).toHaveBeenCalledWith('r1')
  })
})
