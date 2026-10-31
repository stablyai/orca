// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { ChecksPanelCheckAndReviewActionsInput } from './check-and-review-action-dependencies'
import { useChecksPanelCheckAndReviewActions } from './use-checks-panel-check-and-review-actions'

type Input = ChecksPanelCheckAndReviewActionsInput

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  startFixChecksAgent: vi.fn(),
  loadGitLabJobLogDetails: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, message: vi.fn(), success: vi.fn() }
}))
vi.mock('@/lib/fix-checks-agent-launch', () => ({ startFixChecksAgent: mocks.startFixChecksAgent }))
vi.mock('@/runtime/gitlab-job-trace-client', () => ({
  loadGitLabJobLogDetails: mocks.loadGitLabJobLogDetails
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

describe('useChecksPanelCheckAndReviewActions AI details diagnostics', () => {
  beforeEach(() => {
    mocks.startFixChecksAgent.mockReset().mockResolvedValue(true)
    mocks.loadGitLabJobLogDetails.mockReset().mockResolvedValue(null)
  })

  function githubInput(overrides: Partial<Input> = {}): Input {
    return makeInput({
      sourceControlAiActionsVisible: true,
      activeReview: {
        provider: 'github',
        number: 42,
        title: 'Fork PR',
        state: 'open',
        url: 'https://github.example.com/fork/widgets/pull/42',
        status: 'failure',
        updatedAt: '2026-10-13T00:00:00Z',
        mergeable: 'UNKNOWN'
      },
      checks: [
        { name: 'build', status: 'completed', conclusion: 'failure', url: null, checkRunId: 123 }
      ],
      ...overrides
    })
  }

  it('logs only the static category and keeps the existing five-check fetch limit', async () => {
    const original = Object.assign(new Error('SYNTHETIC_SECRET_message'), {
      stack: 'SYNTHETIC_SECRET_stack',
      stdout: 'SYNTHETIC_SECRET_stdout',
      stderr: 'SYNTHETIC_SECRET_stderr',
      cause: { cause: { message: 'SYNTHETIC_SECRET_cause' } },
      response: { error: { message: 'SYNTHETIC_SECRET_rpc' } }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchPRCheckDetails = vi.fn().mockRejectedValueOnce(original).mockResolvedValue(null)
    const checks: Input['checks'] = Array.from({ length: 7 }, (_, index) => ({
      name: `build ${index}`,
      status: 'completed',
      conclusion: 'failure',
      url: null,
      checkRunId: index + 1
    }))
    const input = githubInput({ checks, fetchPRCheckDetails })
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))

    await act(() => result.current.handleFixChecksWithAI())

    expect(warn.mock.calls).toEqual([
      ['[ChecksPanel] failed to load check details for AI fix prompt']
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_SECRET')
    expect(fetchPRCheckDetails).toHaveBeenCalledTimes(5)
    expect(fetchPRCheckDetails.mock.calls.map(([, args]) => args.checkRunId)).toEqual([
      1, 2, 3, 4, 5
    ])
    expect(fetchPRCheckDetails).toHaveBeenNthCalledWith(
      1,
      '/workspace/repo',
      {
        checkRunId: 1,
        workflowRunId: undefined,
        checkName: 'build 0',
        url: null,
        prRepo: null
      },
      { repoId: 'repo-1' }
    )
    expect(mocks.loadGitLabJobLogDetails).not.toHaveBeenCalled()
    expect(mocks.startFixChecksAgent).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.startFixChecksAgent.mock.calls)).not.toContain('SYNTHETIC_SECRET')
    expect(input.setIsFixingChecksWithAI).toHaveBeenNthCalledWith(1, true)
    expect(input.setIsFixingChecksWithAI).toHaveBeenNthCalledWith(2, false)
  })

  it('keeps the stale-result guard after a captured details failure', async () => {
    const upstream = Promise.withResolvers<null>()
    const fetchPRCheckDetails = vi.fn().mockReturnValue(upstream.promise)
    const isCurrentAsyncResult = vi.fn(() => true)
    const input = githubInput({ fetchPRCheckDetails, isCurrentAsyncResult })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))
    let pending: Promise<void> | undefined
    act(() => {
      pending = result.current.handleFixChecksWithAI()
    })
    isCurrentAsyncResult.mockReturnValue(false)
    upstream.reject(new Error('SYNTHETIC_SECRET_stale'))
    await act(async () => {
      await pending
    })

    expect(fetchPRCheckDetails).toHaveBeenCalledOnce()
    expect(isCurrentAsyncResult).toHaveBeenCalledWith('state')
    expect(mocks.startFixChecksAgent).not.toHaveBeenCalled()
    expect(warn.mock.calls).toEqual([
      ['[ChecksPanel] failed to load check details for AI fix prompt']
    ])
    expect(input.setIsFixingChecksWithAI).toHaveBeenLastCalledWith(false)
  })

  it('preserves the GitLab trace path and static failure warning', async () => {
    mocks.loadGitLabJobLogDetails.mockRejectedValue(new Error('SYNTHETIC_SECRET_gitlab'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const input = makeInput({
      sourceControlAiActionsVisible: true,
      checks: [
        {
          name: 'GitLab build',
          status: 'completed',
          conclusion: 'failure',
          url: null,
          gitlabJobId: 99
        }
      ]
    })
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))

    await act(() => result.current.handleFixChecksWithAI())

    expect(mocks.loadGitLabJobLogDetails).toHaveBeenCalledOnce()
    expect(mocks.loadGitLabJobLogDetails).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:ssh-1',
      check: input.checks[0],
      projectRef: null
    })
    expect(input.fetchPRCheckDetails).not.toHaveBeenCalled()
    expect(warn.mock.calls).toEqual([
      ['[ChecksPanel] failed to load check details for AI fix prompt']
    ])
    expect(mocks.startFixChecksAgent).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.startFixChecksAgent.mock.calls)).not.toContain('SYNTHETIC_SECRET')
  })
})

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/12',
    checksStatus: 'pending',
    updatedAt: '2026-05-12T00:00:00Z',
    mergeable: 'MERGEABLE',
    headSha: 'head-sha',
    ...overrides
  }
}

it('link refresh reads the selected GitHub PR after the action at both read seams', async () => {
  const original = useAppStore.getState()
  const old = Promise.withResolvers<{
    kind: 'found'
    pr: ReturnType<typeof makePR>
    fetchedAt: number
  }>()
  const open = makePR({ number: 43, headSha: 'head-a' })
  const selected = makePR({ number: 43, headSha: 'head-b' })
  const refreshPRNow = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce({ kind: 'found', pr: selected, fetchedAt: 2 })
  vi.stubGlobal('api', { gh: { refreshPRNow } })
  const repo = {
    id: 'repo-1',
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '',
    addedAt: 0
  }
  useAppStore.setState({ repos: [repo], prCache: {}, hostedReviewCache: {}, prRefreshStates: {} })
  const input = makeInput({
    repo,
    linkedPR: 43,
    linkedGitLabMR: null,
    fetchPRForBranch: useAppStore.getState().fetchPRForBranch,
    // The card read's failure is not the link's failure: checks still load for the new head.
    fetchHostedReviewForBranch: vi.fn().mockRejectedValue(new Error('lookup capacity reached')),
    fetchPRChecks: vi.fn(async () => []),
    fetchPRComments: vi.fn(async () => [])
  })
  useAppStore.setState({
    worktreesByRepo: {
      [repo.id]: [
        makeWorktree({
          id: input.activeWorktreeId!,
          repoId: repo.id,
          branch: input.branch,
          linkedPR: 43
        })
      ]
    }
  })
  const before = input.fetchPRForBranch(repo.path, input.branch, {
    force: true,
    repoId: repo.id,
    linkedPRNumber: 43,
    reason: 'visible'
  })
  try {
    const { result } = renderHook(() => useChecksPanelCheckAndReviewActions(input))
    await act(async () => result.current.refreshLinkedGitHubPullRequest(43))
    expect(refreshPRNow).toHaveBeenCalledTimes(2)
    expect(refreshPRNow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ linkedPRNumber: 43 }),
        userRefresh: true
      })
    )
    expect(input.fetchHostedReviewForBranch).toHaveBeenCalledWith(
      repo.path,
      input.branch,
      expect.objectContaining({ linkedGitHubPR: 43, userRefresh: true })
    )
    expect(input.fetchPRChecks).toHaveBeenCalledWith(
      repo.path,
      43,
      input.branch,
      'head-b',
      selected.prRepo,
      expect.objectContaining({ userRefresh: true })
    )
    expect(input.fetchPRComments).toHaveBeenCalledWith(
      repo.path,
      43,
      expect.objectContaining({ userRefresh: true })
    )
  } finally {
    old.resolve({ kind: 'found', pr: open, fetchedAt: 1 })
    await before
    useAppStore.setState(original)
    vi.unstubAllGlobals()
  }
})
