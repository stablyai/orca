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

describe('WorktreeCardDetailsHover', () => {
  it('includes branch identity before metadata details', () => {
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
    expect(markup.indexOf('feature/local-branch')).toBeLessThan(markup.indexOf('PR #456'))
    expect(markup).toContain('Fix stale GH PR')
  })

  it('shows an unlink action for linked PR details when provided', () => {
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
        onUnlinkReview={vi.fn()}
      >
        <span>Linked PR</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('aria-label="Unlink PR"')
    expect(markup).toContain('Unlink PR')
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
