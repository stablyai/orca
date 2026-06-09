import { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChecksPanelReviewHeader } from './ChecksPanel'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => <div data-disabled={disabled ? 'true' : undefined}>{children}</div>
}))

function renderHeader(canUnlinkPullRequest = true): string {
  return renderToStaticMarkup(
    <ChecksPanelReviewHeader
      review={{
        provider: 'github',
        number: 2964,
        title: 'fix: pr-bug-scan validated finding',
        state: 'open',
        url: 'https://github.com/stablyai/orca/pull/2964',
        status: 'pending',
        updatedAt: '2026-05-31T22:58:01Z',
        mergeable: 'UNKNOWN'
      }}
      isRefreshing={false}
      canUnlinkPullRequest={canUnlinkPullRequest}
      onRefresh={vi.fn()}
      onOpenReview={vi.fn()}
      onUnlinkPullRequest={vi.fn()}
      onLinkAnotherPullRequest={vi.fn()}
    />
  )
}

describe('ChecksPanelReviewHeader', () => {
  it('opens the PR from the number and puts link management behind the menu', () => {
    const markup = renderHeader()

    expect(markup).toContain('Open on GitHub')
    expect(markup).toContain('#2964')
    expect(markup).toContain('underline decoration-border underline-offset-2')
    expect(markup).toContain('More PR actions')
    expect(markup).toContain('unlink PR')
    expect(markup).toContain('Link another PR')
    expect(markup).toContain('lucide-ellipsis')
    expect(markup).not.toContain('lucide-external-link')
  })

  it('disables unlinking when the displayed PR is not manually linked', () => {
    const markup = renderHeader(false)

    expect(markup).toContain('data-disabled="true"')
    expect(markup).toContain('unlink PR')
  })
})
