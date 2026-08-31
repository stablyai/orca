// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChecksPanelActiveContentModel } from './active-content-props'
import type { ChecksPanelEmptyContentModel } from './empty-content-props'
import { ChecksPanelReviewHeader } from '../ChecksPanel'

vi.mock('../HostedReviewActions', () => ({ default: () => null }))
vi.mock('../SourceControlAgentActionDialog', () => ({ SourceControlAgentActionDialog: () => null }))

import { ChecksPanelActiveContent } from './active-content'
import { ChecksPanelEmptyContent } from './empty-content'

afterEach(cleanup)

describe('checks panel concrete content', () => {
  it('renders the no-workspace empty state with its guidance', () => {
    const model = { activeWorktree: null } as ChecksPanelEmptyContentModel

    render(<ChecksPanelEmptyContent model={model} />)

    expect(screen.getByText('No workspace selected')).toBeTruthy()
    expect(screen.getByText('Select a workspace to view checks')).toBeTruthy()
  })

  it('renders the folder-workspace empty state without review controls', () => {
    const model = {
      activeWorktree: { id: 'folder-1' },
      isFolder: true
    } as ChecksPanelEmptyContentModel

    render(<ChecksPanelEmptyContent model={model} />)

    expect(screen.getByText('Checks unavailable')).toBeTruthy()
    expect(screen.getByText('Checks require a Git branch and hosted review context')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a durable unlinked state that can relink before PR data refetches', () => {
    const handleLinkSuppressedPullRequest = vi.fn<() => void>()
    const model = {
      activeReview: null,
      activeWorktree: { id: 'worktree-1' },
      isFolder: false,
      linkedPR: null,
      linkedReviewNumber: null,
      prNumber: 42,
      suppressedGitHubPR: 42 as number | null,
      handleLinkSuppressedPullRequest: handleLinkSuppressedPullRequest as () => void
    } as ChecksPanelEmptyContentModel

    render(<ChecksPanelEmptyContent model={model} />)

    expect(screen.getByText('Pull request unlinked')).toBeTruthy()
    expect(screen.getByText(/PR #42 is hidden/)).toBeTruthy()
    screen.getByRole('button', { name: 'Link PR #42' }).click()
    expect(handleLinkSuppressedPullRequest).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Create PR/)).toBeNull()
  })

  it('does not apply stale suppression to a branch with no matching pull request', () => {
    const model = {
      activeReview: null,
      activeWorktree: { id: 'worktree-1' },
      branch: 'without-pr',
      checksPanelHasHardRefreshError: false,
      checksPanelReviewLookup: 'not_found',
      checksPanelReviewLookupResult: { openReviewUrl: null },
      confirmedReadiness: { confirmed: false, needsPush: false },
      conflictOperation: 'unknown',
      createComposerOpen: false,
      detachedHeadDisplay: null,
      gitStatusInputs: { hasUncommittedChanges: false },
      gitStatusProbeErrorContextKey: null,
      hardRefreshError: null,
      hostedReviewCreateCopy: { providerName: 'GitHub' },
      hostedReviewCreateProvider: 'github',
      hostedReviewCreation: null,
      isFolder: false,
      isGitHubReviewContext: true,
      isPublishingBranch: false,
      linkedGitLabMR: null,
      linkedPR: null,
      linkedReviewNumber: null,
      panelContextKey: 'worktree-1::without-pr',
      prNumber: null,
      publishActionHasUncommittedChanges: false,
      sourceControlAiActionsVisible: false,
      suppressedGitHubPR: 42
    } as ChecksPanelEmptyContentModel

    render(<ChecksPanelEmptyContent model={model} />)

    expect(screen.getByText('No pull request found')).toBeTruthy()
    expect(screen.queryByText('Pull request unlinked')).toBeNull()
  })

  it('renders the active review header and empty check/comment sections with accessible actions', () => {
    const model = {
      activeConnectionId: null,
      activeConflictReview: null,
      activeGitLabReview: null,
      activeReview: {
        provider: 'github',
        number: 42,
        state: 'open',
        title: 'Preserve mounted panel behavior',
        url: 'https://github.com/orca/app/pull/42',
        status: 'success',
        updatedAt: '2026-08-23T00:00:00.000Z',
        mergeable: 'MERGEABLE'
      },
      activeSourceControlLaunchPlatform: 'darwin',
      activeWorktree: null,
      activeWorktreeId: 'worktree-1',
      agentComposerState: null,
      aiActionDisabledReason: undefined,
      canTargetPRComments: false,
      checks: [],
      checksLoading: false,
      claimedCommentResolutionRef: { current: null },
      commentResolutionLaunchAcceptedRef: { current: false },
      comments: [],
      commentsDisabledReason: undefined,
      commentsLoading: false,
      commentsSelectionClearRequest: null,
      conflictDetailsRefreshing: false,
      consumeClaimedCommentResolutionAfterDeliveryRef: { current: vi.fn() },
      detachedHeadDisplay: null,
      editingTitle: false,
      getGitLabProjectRef: vi.fn(() => null),
      handleAddPRComment: vi.fn(),
      handleCancelEdit: vi.fn(),
      handleDeleteComment: vi.fn(),
      handleEditComment: vi.fn(),
      handleFixChecksWithAI: vi.fn(),
      handleLaunchAborted: vi.fn(),
      handleLaunchAccepted: vi.fn(),
      handleLinkAnotherReview: vi.fn(),
      handleLoadCheckDetails: vi.fn(),
      handleOpenPR: vi.fn(),
      handleRefresh: vi.fn(),
      handleOpenStackPR: vi.fn(),
      handleReplyToComment: vi.fn(),
      handleResolve: vi.fn(),
      handleResolveCommentsWithAI: vi.fn(),
      handleResolveConflictsWithAI: vi.fn(),
      handleSaveTitle: vi.fn(),
      handleSetReaction: vi.fn(),
      handleStartEdit: vi.fn(),
      handleTitleKeyDown: vi.fn(),
      handleUnlinkReview: vi.fn(),
      isFixingChecksWithAI: false,
      isRefreshing: false,
      isResolvingConflictsWithAI: false,
      linkedGitLabMR: null,
      pendingCommentResolutionRef: { current: null },
      pr: null,
      prRefreshState: undefined,
      repo: null,
      refreshHostedReviewAfterMutation: vi.fn(),
      resolveCommentsWithAIDisabledReason: undefined,
      saveLaunchActionDefault: vi.fn(),
      setAgentComposerState: vi.fn(),
      setChecksPanelContentRef: vi.fn(),
      settings: null,
      sourceControlAiActionsVisible: false,
      stateRequestKey: 'review-42',
      titleDraft: '',
      setTitleDraft: vi.fn(),
      titleInputRef: { current: null },
      titleSaving: false
    } satisfies ChecksPanelActiveContentModel

    render(
      <ChecksPanelActiveContent model={model} ReviewHeaderComponent={ChecksPanelReviewHeader} />
    )

    expect(screen.getByText('Preserve mounted panel behavior')).toBeTruthy()
    expect(screen.getByText('No checks configured')).toBeTruthy()
    expect(screen.getByText('No comments')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '#42' }).getAttribute('title')).toContain(
      'Open on GitHub'
    )
  })
})
