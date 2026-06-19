import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode; onSelect?: () => void }) => (
    <div>{children}</div>
  )
}))

describe('WorktreeCardDetailsHover', () => {
  it('puts workspace title before branch identity and metadata details', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        branchName="feature/local-branch"
        workspaceTitle="Fix stale GH PR"
        issue={null}
        linearIssue={null}
        review={{
          provider: 'github',
          number: 456,
          title: 'Fix stale GH PR',
          state: 'open',
          url: 'https://github.com/acme/orca/pull/456',
          status: 'success',
          updatedAt: '2026-05-17T00:00:00.000Z',
          mergeable: 'MERGEABLE'
        }}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
      >
        <span>Fix stale GH PR</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('feature/local-branch')
    expect(markup.indexOf('Fix stale GH PR')).toBeLessThan(markup.indexOf('feature/local-branch'))
    expect(markup.indexOf('feature/local-branch')).toBeLessThan(markup.indexOf('PR #456'))
  })

  it('puts unlink behind the first PR actions menu and keeps GitHub last', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={null}
        review={{
          provider: 'github',
          number: 456,
          title: 'Fix stale GH PR',
          state: 'open',
          url: 'https://github.com/acme/orca/pull/456',
          status: 'success',
          updatedAt: '2026-05-17T00:00:00.000Z',
          mergeable: 'MERGEABLE'
        }}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
        onOpenReviewInOrca={vi.fn()}
        onUnlinkReview={vi.fn()}
      >
        <span>Linked PR</span>
      </WorktreeCardDetailsHover>
    )

    const moreActionsIndex = markup.indexOf('aria-label="More PR actions"')
    const openInOrcaIndex = markup.indexOf('aria-label="Open in Orca"')
    const viewOnGitHubIndex = markup.indexOf('aria-label="View on GitHub"')

    expect(moreActionsIndex).toBeGreaterThan(-1)
    expect(markup).toContain('More PR actions')
    expect(markup).toContain('Unlink PR')
    expect(moreActionsIndex).toBeLessThan(openInOrcaIndex)
    expect(openInOrcaIndex).toBeLessThan(viewOnGitHubIndex)
    expect(markup).not.toContain('aria-label="Unlink PR"')
  })

  it('puts issue edit before open actions and keeps GitHub last', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={{
          number: 5518,
          title: 'Agent monitor lists ephemeral headless subprocesses',
          state: 'closed',
          url: 'https://github.com/acme/orca/issues/5518',
          labels: []
        }}
        linearIssue={null}
        review={null}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
        onOpenGitHubIssueInOrca={vi.fn()}
      >
        <span>Linked issue</span>
      </WorktreeCardDetailsHover>
    )

    const editIssueIndex = markup.indexOf('aria-label="Edit issue"')
    const openInOrcaIndex = markup.indexOf('aria-label="Open in Orca"')
    const viewOnGitHubIndex = markup.indexOf('aria-label="View on GitHub"')

    expect(editIssueIndex).toBeGreaterThan(-1)
    expect(editIssueIndex).toBeLessThan(openInOrcaIndex)
    expect(openInOrcaIndex).toBeLessThan(viewOnGitHubIndex)
  })

  it('labels GitLab unlink actions with MR terminology', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={null}
        review={{
          provider: 'gitlab',
          number: 77,
          title: 'Fix GitLab MR display',
          state: 'open',
          url: 'https://gitlab.com/acme/orca/-/merge_requests/77',
          status: 'success'
        }}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
        onUnlinkReview={vi.fn()}
      >
        <span>Linked MR</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('aria-label="More MR actions"')
    expect(markup).toContain('Unlink MR')
    expect(markup).toContain('View on GitLab')
  })

  it('displays Linear issue details with link', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={{
          identifier: 'ENG-123',
          title: 'Add Linear ticket display feature',
          url: 'https://linear.app/acme/issue/ENG-123',
          stateName: 'In Progress',
          labels: ['feature', 'ui']
        }}
        review={null}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
        onOpenLinearIssueInOrca={vi.fn()}
      >
        <span>ENG-123</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('ENG-123')
    expect(markup).toContain('Add Linear ticket display feature')
    expect(markup).toContain('https://linear.app/acme/issue/ENG-123')
    expect(markup).toContain('View on Linear')
    expect(markup).toContain('In Progress')
  })

  it('shows identifier when Linear issue URL is unavailable', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={{
          identifier: 'ENG-123',
          title: 'Loading Linear issue...'
        }}
        review={null}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
      >
        <span>ENG-123</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('ENG-123')
    expect(markup).toContain('Loading Linear issue...')
    expect(markup).not.toContain('View on Linear')
  })

  it('shows link when fallback URL is provided', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={{
          identifier: 'ENG-123',
          title: 'Loading Linear issue...',
          url: 'https://linear.app/acme/issue/ENG-123'
        }}
        review={null}
        comment={null}
        onEditIssue={vi.fn()}
        onEditComment={vi.fn()}
      >
        <span>ENG-123</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('ENG-123')
    expect(markup).toContain('Loading Linear issue...')
    expect(markup).toContain('https://linear.app/acme/issue/ENG-123')
    expect(markup).toContain('View on Linear')
  })
})
