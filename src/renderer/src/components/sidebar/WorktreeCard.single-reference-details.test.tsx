// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { render, renderHook, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'
import { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import {
  referenceWorkspace,
  referenceRepo,
  referenceLinearIssue
} from './workspace-reference-fixtures.test-support'
import { normalizeTaskSourceContext } from '../../../../shared/task-source-context'
import { getLinearReadScope, scopedLinearCacheKey } from '@/store/slices/linear/linear-slice-scope'

const cache = vi.hoisted(() => ({ entries: {} }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      hostedReviewCache: {},
      prCache: {},
      issueCache: {},
      linearIssueCache: cache.entries
    })
}))
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/SelectedTextCopyMenu', () => ({
  SelectedTextCopyMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('./workspace-delete-quick-action', () => ({
  useWorkspaceDeleteModifierPressed: () => false
}))
afterEach(cleanup)

describe('single linked reference rich hover details', () => {
  it('reuses source-bound Linear details when an exact workspace read is outside the legacy all-workspaces cache slot', () => {
    const source = normalizeTaskSourceContext({
      provider: 'linear',
      projectId: 'project',
      hostId: 'runtime:owner',
      providerIdentity: { provider: 'linear', workspaceId: 'workspace' }
    })
    const item = {
      provider: 'linear' as const,
      type: 'issue' as const,
      number: 0,
      identifier: 'ENG-1',
      url: 'https://linear.app/acme/issue/ENG-1/task',
      taskSourceContext: source ?? undefined
    }
    const workspace = {
      ...referenceWorkspace,
      linkedPR: null,
      linkedLinearIssue: 'ENG-1',
      linkedItems: [item],
      linkedTaskSourceContext: source
    }
    const issue = referenceLinearIssue()
    cache.entries = {
      [scopedLinearCacheKey(getLinearReadScope(null, source), 'workspace::ENG-1')]: {
        data: issue,
        fetchedAt: Date.now()
      }
    }
    const legacy = renderHook(() => {
      const review = useWorktreeCardReviewDetails({
        worktree: workspace,
        repo: referenceRepo,
        settings: null,
        projectGroups: [],
        cardProps: ['linear-issue'],
        newCardStyle: false
      })
      return {
        review,
        linked: useWorktreeCardLinkedDetails({
          worktree: workspace,
          newCardStyle: false,
          deleteState: undefined,
          ...review
        })
      }
    })
    expect(legacy.result.current.review.linearIssueEntry?.data).toEqual(issue)
    const { container } = render(
      <WorktreeCardDetailsHover
        workspace={workspace}
        issue={null}
        linearIssue={legacy.result.current.linked.linearIssueDisplay}
        review={null}
        comment={null}
      >
        <span>Workspace</span>
      </WorktreeCardDetailsHover>
    )
    expect(screen.getByText('Task')).toBeTruthy()
    expect(screen.getByText('State: In Progress')).toBeTruthy()
    expect(screen.queryByText('Loading Linear issue...')).toBeNull()
    expect(container.querySelector('[data-workspace-hover-reference]')).toBeNull()
  })
})
