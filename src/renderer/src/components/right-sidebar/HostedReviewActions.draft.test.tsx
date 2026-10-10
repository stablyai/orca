import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import HostedReviewActions from './HostedReviewActions'
import type { HostedReviewActionInfo } from './use-hosted-review-actions'

const actionMocks = vi.hoisted(() => ({
  handleMarkReadyForReview: vi.fn(),
  handleCloseReview: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: () => false }))
vi.mock('./use-hosted-review-actions', () => ({
  useHostedReviewActions: () => ({
    updatingBranch: false,
    handleUpdateBranch: vi.fn(),
    merging: false,
    readying: false,
    stateUpdating: null,
    actionError: null,
    handleMerge: vi.fn(),
    handleAutoMerge: vi.fn(),
    handleMarkReadyForReview: actionMocks.handleMarkReadyForReview,
    handleCloseReview: actionMocks.handleCloseReview,
    handleReopenReview: vi.fn()
  })
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />
}))

const repo = { id: 'repo-1', path: '/repo' } as Repo
const worktree = { id: 'worktree-1' } as Worktree

function renderDraft(provider: HostedReviewActionInfo['provider']): string {
  return renderToStaticMarkup(
    <HostedReviewActions
      review={{
        provider,
        number: 42,
        state: 'draft',
        status: 'success',
        mergeable: 'UNKNOWN'
      }}
      repo={repo}
      worktree={worktree}
      onRefreshReview={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

describe('HostedReviewActions draft state', () => {
  it.each([
    ['github', 'PR'],
    ['gitlab', 'MR']
  ] as const)('renders Ready as primary and Close as secondary for %s', (provider, shortLabel) => {
    const markup = renderDraft(provider)

    expect(markup).toContain('Mark ready for review')
    expect(markup).toContain(`Close ${shortLabel}`)
    expect(markup).not.toContain('Merge')
    expect(markup).not.toContain('auto-merge')
  })

  it.each(['azure-devops', 'gitea'] as const)(
    'does not misroute unsupported %s drafts through GitHub',
    (provider) => {
      expect(renderDraft(provider)).toBe('')
    }
  )
})

describe('HostedReviewActions update branch placement', () => {
  function renderOpen(provider: HostedReviewActionInfo['provider']): string {
    return renderToStaticMarkup(
      <HostedReviewActions
        review={{
          provider,
          number: 42,
          state: 'open',
          status: 'pending',
          mergeable: 'MERGEABLE',
          autoMergeEnabled: true
        }}
        githubPR={{
          number: 42,
          title: 'Feature',
          state: 'open',
          url: '',
          checksStatus: 'pending',
          updatedAt: '',
          mergeable: 'MERGEABLE',
          headSha: 'a'.repeat(40)
        }}
        repo={repo}
        worktree={worktree}
        onRefreshReview={vi.fn()}
      />
    )
  }

  it('renders Update branch after the green auto-merge action', () => {
    const markup = renderOpen('github')
    expect(markup).toContain('Update branch')
    expect(markup.indexOf('Update branch')).toBeGreaterThan(markup.indexOf('Disable auto-merge'))
    expect(markup).toContain('data-variant="outline"')
  })

  it('does not offer a GitHub update on GitLab reviews', () => {
    expect(renderOpen('gitlab')).not.toContain('Update branch')
  })
})
