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
    merging: false,
    readying: false,
    approving: false,
    stateUpdating: null,
    actionError: null,
    handleMerge: vi.fn(),
    handleAutoMerge: vi.fn(),
    handleMarkReadyForReview: actionMocks.handleMarkReadyForReview,
    handleCloseReview: actionMocks.handleCloseReview,
    handleApproval: vi.fn(),
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

describe('HostedReviewActions open state', () => {
  function renderOpen(
    review: Partial<HostedReviewActionInfo> & Pick<HostedReviewActionInfo, 'provider'>
  ): string {
    return renderToStaticMarkup(
      <HostedReviewActions
        review={{ number: 42, state: 'open', status: 'success', mergeable: 'UNKNOWN', ...review }}
        repo={repo}
        worktree={worktree}
        onRefreshReview={vi.fn().mockResolvedValue(undefined)}
      />
    )
  }
  const approval = {
    approvalsRequired: 1,
    approvalsLeft: 1,
    approvedCount: 0,
    userCanApprove: true,
    userHasApproved: false
  }

  it('shows Approve and progress beside a merge blocked on approval', () => {
    const markup = renderOpen({ provider: 'gitlab', mergeStateStatus: 'not_approved', approval })
    expect(markup).toContain('Approval required')
    expect(markup).toContain('Approve')
    expect(markup).toContain('0 of 1 approvals')
  })

  it('shows neither when GitLab sent no approval data', () => {
    const markup = renderOpen({ provider: 'gitlab' })
    expect(markup).not.toContain('Revoke approval')
    expect(markup).not.toContain('approvals')
  })

  it('never renders approval controls for GitHub', () => {
    expect(renderOpen({ provider: 'github', approval })).not.toContain('approvals')
  })
})
