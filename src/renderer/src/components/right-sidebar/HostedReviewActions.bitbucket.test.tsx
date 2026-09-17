import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import HostedReviewActions from './HostedReviewActions'

vi.mock('@/store', () => ({ useAppStore: () => false }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const repo = { id: 'repo-1', path: '/repo' } as Repo
const worktree = { id: 'worktree-1' } as Worktree

describe('HostedReviewActions Bitbucket integration', () => {
  it('renders merge button and split options for open Bitbucket PR', () => {
    const html = renderToStaticMarkup(
      <HostedReviewActions
        review={{
          provider: 'bitbucket',
          number: 42,
          state: 'open',
          status: 'success',
          mergeable: 'UNKNOWN'
        }}
        repo={repo}
        worktree={worktree}
        onRefreshReview={vi.fn().mockResolvedValue(undefined)}
      />
    )

    // Primary button should show default merge label
    expect(html).toContain('Create merge commit')
    // Dropdown should contain all Bitbucket merge methods
    expect(html).toContain('Squash and merge')
    expect(html).toContain('Fast-forward merge')
    // Dropdown should contain Close PR
    expect(html).toContain('Close')
  })

  it('renders delete workspace button for closed/declined Bitbucket PR', () => {
    const html = renderToStaticMarkup(
      <HostedReviewActions
        review={{
          provider: 'bitbucket',
          number: 42,
          state: 'closed',
          status: 'neutral',
          mergeable: 'UNKNOWN'
        }}
        repo={repo}
        worktree={worktree}
        onRefreshReview={vi.fn().mockResolvedValue(undefined)}
      />
    )

    expect(html).toContain('Delete Workspace')
    expect(html).not.toContain('Reopen')
  })
})
