// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useChecksPanelCheckAndReviewActions } from './use-checks-panel-check-and-review-actions'

type Input = ChecksPanelCheckAndReviewActionsInput

afterEach(cleanup)

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn(), success: vi.fn() }
}))

function renderActions(overrides: Partial<ChecksPanelCheckAndReviewActionsInput> = {}) {
  const updateWorktreeMeta = vi.fn().mockResolvedValue({ ok: true })
  const openModal = vi.fn()
  const model = {
    activeReview: {
      provider: 'github',
      number: 42,
      title: 'Detected PR',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/42',
      status: 'pending',
      updatedAt: '2026-08-27T00:00:00Z',
      mergeable: 'UNKNOWN'
    },
    activeWorktree: {
      id: 'wt-1',
      repoId: 'repo-1',
      hostId: 'ssh:devbox',
      displayName: 'feature',
      linkedIssue: null,
      linkedPR: null,
      comment: ''
    },
    activeWorktreeId: 'wt-1',
    linkedPR: null,
    suppressedGitHubPR: null,
    updateWorktreeMeta,
    openModal,
    ...overrides
  } as unknown as ChecksPanelCheckAndReviewActionsInput

  return {
    ...renderHook(() => useChecksPanelCheckAndReviewActions(model)),
    openModal,
    updateWorktreeMeta
  }
}

describe('useChecksPanelCheckAndReviewActions', () => {
  it('unlinks an auto-detected PR with a durable suppression tombstone', async () => {
    const { result, updateWorktreeMeta } = renderActions()

    await act(() => result.current.handleUnlinkReview())

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-1',
      { linkedPR: null, suppressedGitHubPR: 42 },
      { executionHostId: 'ssh:devbox' }
    )
  })

  it('tombstones the explicit link rather than stale displayed cache data', async () => {
    const { result, updateWorktreeMeta } = renderActions({
      activeReview: {
        provider: 'github',
        number: 43,
        title: 'Stale branch PR'
      } as never,
      linkedPR: 42
    })

    await act(() => result.current.handleUnlinkReview())

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-1',
      { linkedPR: null, suppressedGitHubPR: 42 },
      { executionHostId: 'ssh:devbox' }
    )
  })

  it('surfaces a remote-host capability rejection instead of silently restoring the PR', async () => {
    const updateWorktreeMeta = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Update the remote runtime to unlink GitHub pull requests'
    })
    const { result } = renderActions({ updateWorktreeMeta: updateWorktreeMeta as never })

    await act(() => result.current.handleUnlinkReview())

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Update the remote runtime to unlink GitHub pull requests'
    )
  })

  it('can relink from durable suppression before PR data refetches', () => {
    const { result, openModal } = renderActions({
      activeReview: null,
      suppressedGitHubPR: 42
    })

    act(() => result.current.handleLinkSuppressedPullRequest())

    expect(openModal).toHaveBeenCalledWith(
      'edit-meta',
      expect.objectContaining({ worktreeId: 'wt-1', currentReview: 42, focus: 'pr' })
    )
  })
})

function makeInput(overrides: Partial<Input> = {}): Input {
  const worktree = {
    id: 'repo-1::/workspace/repo',
    repoId: 'repo-1',
    path: '/workspace/repo',
    branch: 'refs/heads/feature/mr',
    hostId: 'ssh:ssh-1',
    displayName: 'MR workspace',
    linkedGitLabMR: 42,
    linkedPR: null,
    suppressedGitHubPR: null,
    comment: ''
  }
  return {
    activeReview: {
      provider: 'gitlab',
      number: 42,
      title: 'GitLab review',
      state: 'open',
      url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
      status: 'success',
      updatedAt: null,
      mergeable: 'UNKNOWN'
    },
    activeWorktree: worktree as Input['activeWorktree'],
    activeWorktreeId: worktree.id,
    asyncResultKeyRef: { current: '' },
    branch: 'feature/mr',
    checks: [],
    fetchHostedReviewForBranch: vi.fn(),
    fetchPRCheckDetails: vi.fn(),
    fetchPRChecks: vi.fn(),
    fetchPRComments: vi.fn(),
    fetchPRForBranch: vi.fn(),
    gitLabProjectRefRef: { current: null },
    isCurrentAsyncResult: vi.fn(() => true),
    isFixingChecksWithAI: false,
    linkedAzureDevOpsPR: null,
    linkedBitbucketPR: null,
    linkedGiteaPR: null,
    linkedGitLabMR: 42,
    linkedPR: null,
    suppressedGitHubPR: null,
    localExecutionScope: null,
    openModal: vi.fn(),
    panelContextKey: 'context',
    panelContextKeyRef: { current: 'context' },
    pr: null,
    prCacheKey: 'pr-cache',
    repo: {
      id: 'repo-1',
      path: '/workspace/repo',
      connectionId: 'ssh-1'
    } as NonNullable<Input['repo']>,
    repoConnectionId: 'ssh-1',
    runtimeEnvironmentId: null,
    settings: null,
    setChecks: vi.fn(),
    setChecksLoading: vi.fn(),
    setComments: vi.fn(),
    setCommentsLoading: vi.fn(),
    setIsFixingChecksWithAI: vi.fn(),
    sourceControlAiActionsVisible: false,
    stateRequestKey: 'state',
    updateWorktreeMeta: vi.fn(),
    ...overrides
  } as Input
}

describe('useChecksPanelCheckAndReviewActions GitLab links', () => {
  it('unlinks the displayed MR through its provider slot', () => {
    const input = makeInput()
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))

    act(() => result.current.handleUnlinkReview())

    expect(input.updateWorktreeMeta).toHaveBeenCalledWith(
      input.activeWorktreeId,
      { linkedGitLabMR: null },
      { executionHostId: 'ssh:ssh-1' }
    )
  })

  it('refreshes a replacement MR on the captured owner and leaves details to the poller', async () => {
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue({
      provider: 'gitlab',
      number: 43,
      title: 'Replacement',
      state: 'open',
      url: 'https://gitlab.example.com/group/repo/-/merge_requests/43',
      status: 'success',
      updatedAt: null,
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })
    const openModal = vi.fn()
    const input = makeInput({ fetchHostedReviewForBranch, openModal })
    const hook = renderHook(({ model }) => useChecksPanelCheckAndReviewActions(model), {
      initialProps: { model: input }
    })

    act(() => hook.result.current.handleLinkAnotherReview())
    const modal = openModal.mock.calls[0]?.[1]
    expect(modal.suppressHostedReviewRefresh).toBe(true)
    hook.rerender({
      model: {
        ...input,
        activeWorktree: { ...input.activeWorktree, linkedGitLabMR: 43 },
        linkedGitLabMR: 43,
        panelContextKey: 'context::gitlab::43'
      } as Input
    })
    await act(async () => modal.afterSave({ updates: { linkedGitLabMR: 43 } }))

    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/mr',
      expect.objectContaining({
        linkedGitLabMR: 43,
        repoOwnerExecutionHostId: 'ssh:ssh-1'
      })
    )
    expect(fetchHostedReviewForBranch).toHaveBeenCalledOnce()
  })
})
