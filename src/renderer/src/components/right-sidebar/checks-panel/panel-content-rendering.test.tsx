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
      linkedPR: null,
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
