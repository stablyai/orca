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

  it('states the count without naming any worktree', async () => {
    const container = await renderLine()

    expect(container.textContent).toContain('24')
    expect(container.textContent).toContain('hidden worktrees')
    // The modal owns the list; the sidebar must not enumerate paths or names.
    expect(container.querySelectorAll('li')).toHaveLength(0)
    expect(container.textContent).not.toContain('Import')
  })

  it('opens review from a single card-wide button', async () => {
    const onReview = vi.fn()
    const container = await renderLine({ onReview })

    const review = getReviewButton(container)
    expect(review).not.toBeNull()
    expect(review?.getAttribute('aria-label')).toBe('Review 24 hidden worktrees in orca')

    await act(async () => {
      review?.click()
    })
    expect(onReview).toHaveBeenCalledTimes(1)
  })

  it('uses the singular noun for one worktree', async () => {
    const container = await renderLine({ inboxCount: 1 })

    expect(container.textContent).toContain('hidden worktree')
    expect(container.textContent).not.toContain('hidden worktrees')
    expect(getReviewButton(container)?.getAttribute('aria-label')).toBe(
      'Review 1 hidden worktree in orca'
    )
  })

  it('names the host so two checkouts of one project are distinguishable', async () => {
    // Both rows read "N hidden worktrees"; only the host tells them apart.
    const local = await renderLine({ hostContextLabel: 'Local Mac', inboxCount: 61 })
    const remote = await renderLine({ hostContextLabel: 'openclaw', inboxCount: 134 })

    expect(local.textContent).toContain('Local Mac')
    expect(getReviewButton(local)?.getAttribute('aria-label')).toBe(
      'Review 61 hidden worktrees in orca on Local Mac'
    )
    expect(getReviewButton(remote)?.getAttribute('aria-label')).toBe(
      'Review 134 hidden worktrees in orca on openclaw'
    )
  })

  it('host-qualifies the suppress control, which writes to that host alone', async () => {
    const container = await renderLine({ hostContextLabel: 'openclaw', onSuppress: vi.fn() })

    expect(
      container.querySelector(
        'button[aria-label="Hide external worktrees permanently for orca on openclaw"]'
      )
    ).not.toBeNull()
  })

  it('stays unqualified when the project has a single checkout', async () => {
    const container = await renderLine()

    expect(getReviewButton(container)?.getAttribute('aria-label')).toBe(
      'Review 24 hidden worktrees in orca'
    )
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
    // Nested buttons would make the suppress click ambiguous.
    expect(getReviewButton(container)?.contains(suppressButton)).toBe(false)

    await act(async () => {
      suppressButton?.click()
    })
    expect(onSuppress).toHaveBeenCalledTimes(1)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('disables both actions while a mutation is pending', async () => {
    const container = await renderLine({ pending: true })

    expect(getReviewButton(container)?.disabled).toBe(true)
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Hide external worktrees permanently for orca"]'
      )?.disabled
    ).toBe(true)
    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
  })

  it('renders nothing when the inbox is empty', async () => {
    const container = await renderLine({ inboxCount: 0 })

    expect(container.querySelector('section')).toBeNull()
  })

  it('surfaces the action error as an alert', async () => {
    const container = await renderLine({ error: 'Could not import external worktrees. Try again.' })

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Could not import external worktrees. Try again.')
  })
})
