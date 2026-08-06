import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeCardReviewStatus } from './WorktreeCardReviewStatus'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

type ReviewOverrides = {
  provider?: Exclude<WorktreeCardPrDisplay['provider'], 'unsupported'>
  state?: WorktreeCardPrDisplay['state']
  status?: WorktreeCardPrDisplay['status']
}

function renderReview(overrides: ReviewOverrides = {}): string {
  const review: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 123,
    title: 'Review me',
    state: 'open',
    ...overrides
  }
  return renderToStaticMarkup(<WorktreeCardReviewStatus review={review} />)
}

describe('WorktreeCardReviewStatus', () => {
  it.each([
    [{ state: 'merged' }, 'PR: Merged'],
    [{ state: 'closed' }, 'PR: Closed'],
    [{ state: 'draft' }, 'PR: Draft'],
    [{ status: 'failure' }, 'PR checks: Failed'],
    [{ status: 'pending' }, 'PR checks: Pending'],
    [{ status: 'success' }, 'PR checks: Passing'],
    [{}, 'PR: Open']
  ] as const)('describes review state %o as %s', (overrides, label) => {
    expect(renderReview(overrides)).toContain(label)
  })

  it('uses the compact generic review glyph in its own lane', () => {
    const markup = renderReview({ provider: 'gitlab', status: 'pending' })

    expect(markup).toContain('data-worktree-card-review-status=""')
    expect(markup).toContain('MR checks: Pending')
    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).toContain('size-[13px]')
    expect(markup).toContain('text-amber-500/85')
    expect(markup).not.toContain('lucide-git-merge')
  })
})
