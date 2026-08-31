// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateHostedReviewResult } from '../../../../../shared/hosted-review'
import { useChecksPanelCreateReview } from './use-checks-panel-create-review'

type CreateInput = Parameters<typeof useChecksPanelCreateReview>[0]

afterEach(cleanup)

describe('useChecksPanelCreateReview provider flow', () => {
  it('sends normalized GitHub create input and releases the in-flight gate after success', async () => {
    const createdReview: CreateHostedReviewResult = {
      ok: true,
      number: 42,
      url: 'https://github.com/orca/app/pull/42'
    }
    const createHostedReview: CreateInput['createHostedReview'] = vi.fn(async () => createdReview)
    const refreshLinkedGitHubPullRequest: CreateInput['refreshLinkedGitHubPullRequest'] = vi.fn()
    const setIsCreatingPr: CreateInput['setIsCreatingPr'] = vi.fn()
    const createPrInFlightRef = { current: null as string | null }
    const input: CreateInput = {
      activePullRequestGenerationKey: null,
      activeWorktreeId: null,
      activeWorktreePath: '/workspace/repo',
      branch: 'refs/heads/feature/create',
      createComposerOpen: true,
      createHostedReview,
      createPrInFlightRef,
      createPrPushFirst: false,
      createStackedHostedReview: vi.fn(),
      fallbackGitHubPRNumber: null,
      fetchGitLabDetails: vi.fn(),
      fetchHostedReviewForBranch: vi.fn(),
      hostedReviewCreateCopy: {
        providerName: 'GitHub',
        reviewLabel: 'pull request',
        shortLabel: 'PR',
        titleLabel: 'Pull request'
      } as CreateInput['hostedReviewCreateCopy'],
      hostedReviewCreateProvider: 'github',
      hostedReviewCreation: null,
      linkedAzureDevOpsPR: null,
      linkedBitbucketPR: null,
      linkedGiteaPR: null,
      linkedGitLabMR: null,
      linkedPR: null,
      panelContextKey: 'repo-1::worktree-1::feature/create',
      panelContextKeyRef: { current: 'repo-1::worktree-1::feature/create' },
      prBase: 'refs/remotes/origin/main',
      prBody: 'Create body',
      prCreationDefaults: {
        draft: false,
        generateDetailsOnOpen: false,
        openAfterCreate: false,
        useTemplate: true
      },
      prDraft: true,
      prGenerating: false,
      prTitle: '  Create title  ',
      pushBeforeCreatePullRequest: vi.fn(async () => true),
      refreshLinkedGitHubPullRequest,
      repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<CreateInput['repo']>,
      setCreatePrError: vi.fn(),
      setGitStatusRefreshNonce: vi.fn(),
      setIsCreatingPr,
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn(),
      updatePullRequestGenerationRecord: vi.fn(),
      updateWorktreeMeta: vi.fn()
    }
    const { result } = renderHook(() => useChecksPanelCreateReview(input))

    await act(async () => result.current.handleCreatePullRequest(false))

    expect(createHostedReview).toHaveBeenCalledWith('/workspace/repo', {
      repoId: 'repo-1',
      provider: 'github',
      base: 'main',
      head: 'feature/create',
      title: 'Create title',
      body: 'Create body',
      draft: true,
      worktreePath: '/workspace/repo',
      useTemplate: true
    })
    expect(refreshLinkedGitHubPullRequest).toHaveBeenCalledWith(42)
    expect(setIsCreatingPr).toHaveBeenNthCalledWith(1, true)
    expect(setIsCreatingPr).toHaveBeenLastCalledWith(false)
    expect(createPrInFlightRef.current).toBeNull()
  })
})
