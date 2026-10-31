// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChecksPanelActiveContentModel } from './active-content-props'
import type { ChecksPanelEmptyContentModel } from './empty-content-props'

vi.mock('../HostedReviewActions', () => ({ default: () => null }))
vi.mock('../SourceControlAgentActionDialog', () => ({ SourceControlAgentActionDialog: () => null }))

import { ChecksPanelActiveContent } from './active-content'
import { ChecksPanelEmptyContent } from './empty-content'
import { getHostedReviewManualRefreshError } from '../github-refresh-error-copy'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('checks panel concrete content', () => {
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

    const { rerender } = render(<ChecksPanelEmptyContent model={model} />)

    expect(screen.getByText('No pull request found')).toBeTruthy()
    expect(screen.queryByText('Pull request unlinked')).toBeNull()
    rerender(
      <ChecksPanelEmptyContent
        model={{ ...model, manualRefreshError: getHostedReviewManualRefreshError('gitlab') }}
      />
    )
    expect(screen.getByText('Refresh failed')).toBeTruthy()
    expect(screen.getByText("Couldn't refresh from GitLab. Try again.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })

  it.each([
    [
      'rate limited',
      { status: 'error', errorType: 'rate_limited' },
      'GitHub refresh paused',
      'Orca will retry at',
      true
    ],
    [
      'signed out',
      { status: 'error', errorType: 'auth' },
      'GitHub authentication failed',
      'Check the GitHub login',
      false
    ]
  ] as const)(
    'keeps the classified GitHub empty state over a manual failure (%s)',
    (_name, refresh, title, nextStep, retryDisabled) => {
      const now = Date.parse('2026-10-30T12:00:00Z')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(now)
      const model: ChecksPanelEmptyContentModel = {
        activeReview: null,
        activeWorktree: makeWorktree({ id: 'worktree-1', repoId: 'repo-1' }),
        activeWorktreeId: 'worktree-1',
        branch: 'without-pr',
        checksPanelHasHardRefreshError: false,
        checksPanelReviewLookup: 'unknown',
        checksPanelReviewLookupResult: { state: 'unknown', openReviewUrl: null },
        confirmedReadiness: { confirmed: false, needsPush: false },
        conflictOperation: 'unknown',
        createComposerOpen: false,
        createPrError: null,
        createPrPushFirst: false,
        detachedHeadDisplay: null,
        emptyRefreshing: false,
        gitStatusInputs: { hasUncommittedChanges: false, remoteStatus: undefined },
        gitStatusProbeErrorContextKey: null,
        handleCancelGeneratePullRequestFields: vi.fn(),
        handleCreatePullRequest: vi.fn(),
        handleGeneratePullRequestFields: vi.fn(),
        handleLinkSuppressedPullRequest: vi.fn(),
        handlePrBaseChange: vi.fn(),
        handlePrTitleChange: vi.fn(),
        handlePublishBranch: vi.fn(),
        handleRefresh: vi.fn(async () => {}),
        handleSyncBranch: vi.fn(),
        hardRefreshError: null,
        hostedReviewCreateCopy: localizedHostedReviewCopy('github'),
        hostedReviewCreateProvider: 'github',
        hostedReviewCreation: null,
        isCreatingPr: false,
        isFolder: false,
        isGitHubReviewContext: true,
        isPublishingBranch: false,
        isRemoteOperationActive: false,
        isSyncingBranch: false,
        linkedGitLabMR: null,
        linkedPR: null,
        linkedReviewNumber: null,
        manualRefreshError: getHostedReviewManualRefreshError('github'),
        panelContextKey: 'worktree-1::without-pr',
        prAiGenerationEnabled: false,
        prBase: '',
        prBaseQuery: '',
        prBaseResults: [],
        prBaseSearchError: null,
        prBaseSearchPending: false,
        prBody: '',
        prDraft: false,
        prGenerateDisabled: false,
        prGenerateDisabledReason: undefined,
        prGenerateError: null,
        prGenerating: false,
        prNumber: null,
        prRefreshState: {
          ...refresh,
          reason: 'manual',
          updatedAt: now,
          nextAutoRetryAt: now + 600_000,
          retryDisabledUntil: retryDisabled ? now + 600_000 : undefined
        },
        prRepoDefaultBaseRef: null,
        prStackedCreationSupported: false,
        prTitle: '',
        publishActionHasUncommittedChanges: false,
        publishActionRemoteStatus: undefined,
        setEmptyRefreshing: vi.fn(),
        setPrBaseQuery: vi.fn(),
        setPrBaseResults: vi.fn(),
        setPrBody: vi.fn(),
        setPrDraft: vi.fn(),
        sourceControlAiActionsVisible: false,
        stackParentReview: null,
        suppressedGitHubPR: null
      }

      const { container } = render(<ChecksPanelEmptyContent model={model} />)

      expect(container.textContent).toContain(title)
      expect(container.textContent).toContain(nextStep)
      expect(container.textContent).not.toContain('Refresh failed')
      expect(container.textContent).not.toContain('Try again')
    }
  )

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
      fixChecksDisabledReason: undefined,
      canTargetPRComments: false,
      checks: [],
      checksError: null,
      checksLoading: false,
      claimedCommentResolutionRef: { current: null },
      commentResolutionLaunchAcceptedRef: { current: false },
      comments: [],
      commentsDisabledReason: undefined,
      commentsError: null,
      commentsLoading: false,
      commentsSelectionClearRequest: null,
      conflictDetailsRefreshing: false,
      detachedHeadDisplay: null,
      editingTitle: false,
      getGitLabProjectRef: vi.fn(() => null),
      handleAddPRComment: vi.fn(),
      handleCancelEdit: vi.fn(),
      handleDeleteComment: vi.fn(),
      handleEditComment: vi.fn(),
      handleFixChecksWithAI: vi.fn(),
      handleLinkAnotherReview: vi.fn(),
      handleLoadCheckDetails: vi.fn(),
      handleOpenPR: vi.fn(),
      handleRefresh: vi.fn(),
      manualRefreshError: null,
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

    const { rerender } = render(<ChecksPanelActiveContent model={model} />)

    expect(screen.getByText('Preserve mounted panel behavior')).toBeTruthy()
    expect(screen.getByText('No checks configured')).toBeTruthy()
    expect(screen.getByText('No comments')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '#42' }).getAttribute('title')).toContain(
      'Open on GitHub'
    )
    const failedModel = {
      ...model,
      checksError: 'Previous detail error',
      commentsError: 'Previous detail error',
      manualRefreshError: getHostedReviewManualRefreshError('gitlab'),
      activeReview: { ...model.activeReview, provider: 'gitlab' as const },
      isRefreshing: true
    }
    rerender(<ChecksPanelActiveContent model={failedModel} />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toBe("Couldn't refresh from GitLab. Try again.")
    expect(screen.getByText('Preserve mounted panel behavior')).toBeTruthy()
    expect(screen.queryByText('Previous detail error')).toBeNull()
    rerender(
      <ChecksPanelActiveContent
        model={{
          ...failedModel,
          activeReview: model.activeReview,
          prRefreshState: { status: 'error', errorType: 'network', reason: 'manual', updatedAt: 1 }
        }}
      />
    )
    // The classified GitHub line says more than the manual failure, so it is the one shown.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('GitHub is unreachable right now')
  })
})
