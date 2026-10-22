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
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const relandedIn = [
  {
    number: 26942,
    title: 'Fix Codex usage bypassing configured proxy routing',
    url: 'https://github.com/stablyai/orca/pull/26942',
    author: 'nwparker',
    mergedAt: '2026-10-11T02:00:00Z'
  }
]

function review(state: 'open' | 'closed' | 'merged') {
  return {
    provider: 'github' as const,
    number: 26497,
    title: 'fix(rate-limits): send Codex usage through the proxy set in settings',
    state,
    url: 'https://github.com/stablyai/orca/pull/26497',
    relandedIn
  }
}

function hover(state: 'open' | 'closed' | 'merged'): string {
  return renderToStaticMarkup(
    <WorktreeCardDetailsHover issue={null} linearIssue={null} review={review(state)} comment={null}>
      <span>Workspace card</span>
    </WorktreeCardDetailsHover>
  )
}

describe('closed PR re-landed elsewhere', () => {
  it('shows the merged PR that carried a closed PR’s work, with a link', () => {
    const markup = hover('closed')

    expect(markup).toContain('Re-landed in')
    expect(markup).toContain('#26942')
    expect(markup).toContain('nwparker')
    expect(markup).toContain('href="https://github.com/stablyai/orca/pull/26942"')
  })

  it('says nothing about re-landing for an open or merged PR', () => {
    expect(hover('open')).not.toContain('Re-landed in')
    expect(hover('merged')).not.toContain('Re-landed in')
  })
})
