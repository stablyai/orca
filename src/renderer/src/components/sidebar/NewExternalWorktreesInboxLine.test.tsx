// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NewExternalWorktreesInboxLine from './NewExternalWorktreesInboxLine'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip-content">{children}</span>
  )
}))

const roots: Root[] = []

type RenderOverrides = {
  hostContextLabel?: string
  inboxCount?: number
  pending?: boolean
  error?: string | null
  onReview?: () => void
  onSuppress?: () => void
}

async function renderLine(overrides: RenderOverrides = {}): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)

  await act(async () => {
    root.render(
      <NewExternalWorktreesInboxLine
        repoDisplayName="orca"
        hostContextLabel={overrides.hostContextLabel}
        inboxCount={overrides.inboxCount ?? 24}
        pending={overrides.pending ?? false}
        error={overrides.error ?? null}
        onReview={overrides.onReview ?? vi.fn()}
        onSuppress={overrides.onSuppress ?? vi.fn()}
      />
    )
  })

  return container
}

function getReviewButton(container: HTMLDivElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label^="Review "]')
}

describe('NewExternalWorktreesInboxLine', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('keeps suppress as a hover-revealed control that does not trigger review', async () => {
    const onReview = vi.fn()
    const onSuppress = vi.fn()
    const container = await renderLine({ onReview, onSuppress })

    const suppressButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Hide external worktrees permanently for orca"]'
    )
    expect(suppressButton).not.toBeNull()
    expect(suppressButton?.className).toContain('can-hover:group-hover:opacity-100')
    expect(container.textContent).toContain("Don't show again")
    expect(getReviewButton(container)?.contains(suppressButton)).toBe(false)

    await act(async () => {
      suppressButton?.click()
    })
    expect(onSuppress).toHaveBeenCalledTimes(1)
    expect(onReview).not.toHaveBeenCalled()
  })
})
