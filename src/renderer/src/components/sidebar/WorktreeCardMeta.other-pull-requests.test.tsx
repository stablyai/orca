import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover, WorktreeCardMetaBadges } from './WorktreeCardMeta'

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

const issue = {
  number: 28343,
  title: 'Clicking host menu items toggles the host accordion',
  state: 'open' as const,
  url: 'https://github.com/stablyai/orca/issues/28343',
  labels: [],
  otherOpenPullRequests: [
    {
      number: 28628,
      title: 'fix(sidebar): keep host menu actions from collapsing the host section',
      url: 'https://github.com/stablyai/orca/pull/28628',
      author: 'lesbass',
      headRefName: 'fix/host-menu-actions',
      createdAt: '2026-10-14T07:00:00Z'
    }
  ]
}

describe('other open PRs for the linked issue', () => {
  it('flags the workspace row when someone else has an open PR for its issue', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardMetaBadges issue={issue} linearIssue={null} review={null} comment={null} />
    )

    expect(markup).toContain('1 other open PR for issue #28343')
  })

  it('lists who opened the other PR, with a link, in the issue details', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardDetailsHover issue={issue} linearIssue={null} review={null} comment={null}>
        <span>Workspace card</span>
      </WorktreeCardDetailsHover>
    )

    expect(markup).toContain('Other open PRs for this issue')
    expect(markup).toContain('#28628')
    expect(markup).toContain('lesbass')
    expect(markup).toContain('href="https://github.com/stablyai/orca/pull/28628"')
  })

  it('shows nothing extra when no one else has a PR open', () => {
    const quiet = { ...issue, otherOpenPullRequests: [] }
    const badges = renderToStaticMarkup(
      <WorktreeCardMetaBadges issue={quiet} linearIssue={null} review={null} comment={null} />
    )
    const hover = renderToStaticMarkup(
      <WorktreeCardDetailsHover issue={quiet} linearIssue={null} review={null} comment={null}>
        <span>Workspace card</span>
      </WorktreeCardDetailsHover>
    )

    expect(badges).not.toContain('other open PR')
    expect(hover).not.toContain('Other open PRs for this issue')
  })
})
