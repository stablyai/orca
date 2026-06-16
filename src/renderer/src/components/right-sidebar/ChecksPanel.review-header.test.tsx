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

function renderHeader({
  canUnlinkPullRequest = true,
  provider = 'github'
}: {
  canUnlinkPullRequest?: boolean
  provider?: 'github' | 'gitlab'
} = {}): string {
  const isGitLab = provider === 'gitlab'
  return renderToStaticMarkup(
    <ChecksPanelReviewHeader
      review={{
        provider,
        number: isGitLab ? 31 : 2964,
        title: isGitLab ? 'Fix GitLab MR creation' : 'fix: pr-bug-scan validated finding',
        state: 'open',
        url: isGitLab
          ? 'https://gitlab.com/acme/orca/-/merge_requests/31'
          : 'https://github.com/stablyai/orca/pull/2964',
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
    const markup = renderHeader({ canUnlinkPullRequest: false })

    expect(markup).toContain('data-disabled="true"')
    expect(markup).toContain('unlink PR')
  })

  it('shows GitLab MR identity without GitHub-only link management actions', () => {
    const markup = renderHeader({ provider: 'gitlab' })

    expect(markup).toContain('Open on GitLab')
    expect(markup).toContain('!31')
    expect(markup).not.toContain('More PR actions')
    expect(markup).not.toContain('unlink PR')
    expect(markup).not.toContain('Link another PR')
  })
})
