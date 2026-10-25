import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import HostedReviewActions from './HostedReviewActions'
import type { HostedReviewActionInfo } from './use-hosted-review-actions'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import { gitHubPRToChecksPanelReview } from './checks-panel-review'

const actionMocks = vi.hoisted(() => ({
  handleMarkReadyForReview: vi.fn(),
  handleCloseReview: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: () => false }))
vi.mock('./use-hosted-review-actions', () => ({
  useHostedReviewActions: () => ({
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

describe('HostedReviewActions GitHub merge selection', () => {
  it.each([
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      status: 'pending',
      label: 'Squash and merge',
      autoMerge: false
    },
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      status: 'failure',
      label: 'Squash and merge',
      autoMerge: false
    },
    {
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'UNKNOWN',
      status: 'pending',
      label: 'Checking',
      autoMerge: false
    },
    { mergeable: 'UNKNOWN', status: 'pending', label: 'Checking', autoMerge: false },
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      status: 'pending',
      label: 'Enable auto-merge',
      autoMerge: true
    },
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      status: 'success',
      label: 'Enable auto-merge',
      autoMerge: true
    },
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      autoMergeEnabled: true,
      status: 'pending',
      label: 'Disable auto-merge',
      autoMerge: true
    },
    {
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
      mergeQueueRequired: true,
      status: 'pending',
      label: 'Merge when ready',
      autoMerge: false
    },
    {
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      mergeQueueRequired: true,
      status: 'pending',
      label: 'Conflicts',
      autoMerge: false
    }
  ] as const)('renders $label for $mergeStateStatus / $status', (scenario) => {
    const pr: PRInfo = {
      number: 31259,
      title: 'fix(i18n): restore localized editor safety copy',
      state: 'open',
      url: 'https://github.com/stablyai/orca/pull/31259',
      updatedAt: '2026-10-21T16:31:00Z',
      headSha: 'e4353ead012043474fc723e50aea198a76d32979',
      autoMergeAllowed: true,
      checksStatus: scenario.status,
      ...scenario
    }
    const markup = renderToStaticMarkup(
      <HostedReviewActions
        review={gitHubPRToChecksPanelReview(pr)}
        githubPR={pr}
        repo={repo}
        worktree={worktree}
        onRefreshReview={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(markup).toContain(scenario.label)
    expect(markup.includes('Enable auto-merge') || markup.includes('Disable auto-merge')).toBe(
      scenario.autoMerge
    )
    if (scenario.label === 'Checking' || scenario.label === 'Conflicts') {
      expect(markup).toMatch(/<button[^>]*disabled=""/)
    }
  })
})
