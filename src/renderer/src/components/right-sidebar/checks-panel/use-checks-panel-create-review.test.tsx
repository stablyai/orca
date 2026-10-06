// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { CreateHostedReviewResult } from '../../../../../shared/hosted-review'
import { getDefaultSourceControlAiSettings } from '../../../../../shared/source-control-ai-settings'
import type * as HttpLinkRouting from '@/lib/http-link-routing'
import { useChecksPanelCreateReview } from './use-checks-panel-create-review'

const { openHttpLink } = vi.hoisted(() => ({ openHttpLink: vi.fn() }))
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRouting>()),
  openHttpLink
}))

type CreateInput = Parameters<typeof useChecksPanelCreateReview>[0]

afterEach(() => {
  cleanup()
  openHttpLink.mockClear()
  useAppStore.setState({ activeWorktreeId: null })
})

function makeInput(overrides: Partial<CreateInput> = {}): CreateInput {
  const createdReview: CreateHostedReviewResult = {
    ok: true,
    number: 42,
    url: 'https://github.com/orca/app/pull/42'
  }
  return {
    activePullRequestGenerationKey: null,
    activeWorktreeId: null,
    activeWorktreePath: '/workspace/repo',
    branch: 'refs/heads/feature/create',
    createComposerOpen: true,
    createHostedReview: vi.fn(async () => createdReview),
    createPrInFlightRef: { current: null },
    createPrPushFirst: false,
    createStackedHostedReview: vi.fn(),
    fallbackGitHubPRNumber: null,
    fetchGitLabDetails: vi.fn(),
    fetchHostedReviewForBranch: vi.fn(),
    handleGeneratePullRequestFields: vi.fn(async () => {}),
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
    mountedRef: { current: true },
    ownerSettings: null,
    panelContextKey: 'repo-1::worktree-1::feature/create',
    panelContextKeyRef: { current: 'repo-1::worktree-1::feature/create' },
    prAiGenerationEnabled: false,
    prBase: 'refs/remotes/origin/main',
    prBody: 'Create body',
    prCreationDefaults: {
      draft: false,
      generateDetailsOnOpen: false,
      openAfterCreate: false,
      useTemplate: true
    },
    prDraft: true,
    prFieldsAreSeedPlaceholders: false,
    prGenerating: false,
    prTitle: '  Create title  ',
    pushBeforeCreatePullRequest: vi.fn(async () => true),
    refreshLinkedGitHubPullRequest: vi.fn(),
    repo: { id: 'repo-1', path: '/workspace/repo' } as NonNullable<CreateInput['repo']>,
    setCreatePrError: vi.fn(),
    setGitStatusRefreshNonce: vi.fn(),
    setIsCreatingPr: vi.fn(),
    setRightSidebarOpen: vi.fn(),
    setRightSidebarTab: vi.fn(),
    updatePullRequestGenerationRecord: vi.fn(),
    updateWorktreeMeta: vi.fn(),
    ...overrides
  }
}

describe('useChecksPanelCreateReview provider flow', () => {
  it('sends normalized GitHub create input and releases the in-flight gate after success', async () => {
    const input = makeInput()
    const {
      createHostedReview,
      createPrInFlightRef,
      refreshLinkedGitHubPullRequest,
      setIsCreatingPr
    } = input
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

  it('generates details, then creates with them, when the composer still holds placeholders', async () => {
    const input = makeInput({
      activePullRequestGenerationKey: 'worktree-1::repo-1::feature/create',
      handleGeneratePullRequestFields: vi.fn(async () => ({
        result: { base: 'main', title: 'Add create flow', body: 'Details.', draft: false }
      })),
      ownerSettings: {
        ...getDefaultSettings('/home/test'),
        sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' }
      },
      prAiGenerationEnabled: true,
      prFieldsAreSeedPlaceholders: true
    })
    const { result } = renderHook(() => useChecksPanelCreateReview(input))

    await act(async () => result.current.handleCreatePullRequest(false))

    expect(input.handleGeneratePullRequestFields).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/workspace/repo',
      expect.objectContaining({
        base: 'main',
        title: 'Add create flow',
        body: 'Details.',
        draft: false
      })
    )
  })

  it('creates with the finished run even while the panel still shows it generating', async () => {
    const generated = { base: 'main', title: 'Add create flow', body: 'Details.', draft: false }
    let finish: () => void = () => {}
    const input = makeInput({
      activePullRequestGenerationKey: 'worktree-1::repo-1::feature/create',
      handleGeneratePullRequestFields: vi.fn(
        () =>
          new Promise<{ result: typeof generated }>((resolve) => {
            finish = () => resolve({ result: generated })
          })
      ),
      ownerSettings: {
        ...getDefaultSettings('/home/test'),
        sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' }
      },
      prAiGenerationEnabled: true,
      prFieldsAreSeedPlaceholders: true
    })
    const { result, rerender } = renderHook(
      (props: CreateInput) => useChecksPanelCreateReview(props),
      { initialProps: input }
    )

    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = result.current.handleCreatePullRequest(false)
    })
    rerender({ ...input, prGenerating: true })
    await act(async () => {
      finish()
      await click
    })

    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/workspace/repo',
      expect.objectContaining({ title: 'Add create flow', body: 'Details.' })
    )
  })
  it.each([
    { name: 'still selected', selectedAtFinish: 'worktree-1', reveals: true },
    { name: 'no longer selected', selectedAtFinish: 'worktree-2', reveals: false }
  ])(
    'reveals the created PR only when its worktree is $name after the panel closed mid-run',
    async ({ selectedAtFinish, reveals }) => {
      useAppStore.setState({ activeWorktreeId: 'worktree-1' })
      let finish: () => void = () => {}
      const input = makeInput({
        activePullRequestGenerationKey: 'worktree-1::repo-1::feature/create',
        activeWorktreeId: 'worktree-1',
        handleGeneratePullRequestFields: vi.fn(
          () =>
            new Promise<{ result: { base: string; title: string; body: string; draft: boolean } }>(
              (resolve) => {
                finish = () =>
                  resolve({
                    result: { base: 'main', title: 'Add create flow', body: '', draft: false }
                  })
              }
            )
        ),
        ownerSettings: {
          ...getDefaultSettings('/home/test'),
          sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' }
        },
        prAiGenerationEnabled: true,
        prCreationDefaults: {
          draft: false,
          generateDetailsOnOpen: false,
          openAfterCreate: true,
          useTemplate: true
        },
        prFieldsAreSeedPlaceholders: true
      })
      const { result, unmount } = renderHook(() => useChecksPanelCreateReview(input))

      let click: Promise<void> = Promise.resolve()
      act(() => {
        click = result.current.handleCreatePullRequest(false)
      })
      unmount()
      input.mountedRef.current = false
      useAppStore.setState({ activeWorktreeId: selectedAtFinish })
      await act(async () => {
        finish()
        await click
      })

      expect(input.createHostedReview).toHaveBeenCalledTimes(1)
      expect(input.updateWorktreeMeta).toHaveBeenCalledWith('worktree-1', expect.anything())
      expect(input.setRightSidebarTab).toHaveBeenCalledTimes(reveals ? 1 : 0)
      expect(openHttpLink).toHaveBeenCalledTimes(reveals ? 1 : 0)
    }
  )

  it.each(['github', 'gitlab'] as const)(
    'links the %s review to the clicked worktree, without touching the panel, when the panel moved on mid-run',
    async (provider) => {
      useAppStore.setState({ activeWorktreeId: 'worktree-1' })
      let finish: () => void = () => {}
      const input = makeInput({
        activePullRequestGenerationKey: 'worktree-1::repo-1::feature/create',
        activeWorktreeId: 'worktree-1',
        handleGeneratePullRequestFields: vi.fn(
          () =>
            new Promise<{ result: { base: string; title: string; body: string; draft: boolean } }>(
              (resolve) => {
                finish = () =>
                  resolve({
                    result: { base: 'main', title: 'Add create flow', body: '', draft: false }
                  })
              }
            )
        ),
        hostedReviewCreateProvider: provider,
        ownerSettings: {
          ...getDefaultSettings('/home/test'),
          sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' }
        },
        prAiGenerationEnabled: true,
        prCreationDefaults: {
          draft: false,
          generateDetailsOnOpen: false,
          openAfterCreate: true,
          useTemplate: true
        },
        prFieldsAreSeedPlaceholders: true
      })
      const { result, rerender } = renderHook(
        (props: CreateInput) => useChecksPanelCreateReview(props),
        { initialProps: input }
      )

      let click: Promise<void> = Promise.resolve()
      act(() => {
        click = result.current.handleCreatePullRequest(false)
      })
      // The still-mounted panel switches to another worktree, as a worktree switch does.
      useAppStore.setState({ activeWorktreeId: 'worktree-2' })
      input.panelContextKeyRef.current = 'repo-1::worktree-2::feature/other'
      rerender({
        ...input,
        activePullRequestGenerationKey: 'worktree-2::repo-1::feature/other',
        activeWorktreeId: 'worktree-2',
        branch: 'refs/heads/feature/other',
        createComposerOpen: false,
        panelContextKey: 'repo-1::worktree-2::feature/other'
      })
      await act(async () => {
        finish()
        await click
      })

      expect(input.createHostedReview).toHaveBeenCalledWith(
        '/workspace/repo',
        expect.objectContaining({ head: 'feature/create', title: 'Add create flow' })
      )
      expect(input.updateWorktreeMeta).toHaveBeenCalledWith('worktree-1', expect.anything())
      expect(input.updatePullRequestGenerationRecord).toHaveBeenCalledWith(
        'worktree-1::repo-1::feature/create',
        expect.any(Function)
      )
      expect(input.setIsCreatingPr).not.toHaveBeenCalled()
      expect(input.setCreatePrError).not.toHaveBeenCalled()
      expect(input.createPrInFlightRef.current).toBeNull()
      expect(input.fetchGitLabDetails).not.toHaveBeenCalled()
      expect(input.setRightSidebarTab).not.toHaveBeenCalled()
      expect(openHttpLink).not.toHaveBeenCalled()
    }
  )

  it('opens the created PR while the panel is still showing it, even when another worktree is selected', async () => {
    useAppStore.setState({ activeWorktreeId: 'worktree-2' })
    const input = makeInput({
      activeWorktreeId: 'worktree-1',
      prCreationDefaults: {
        draft: false,
        generateDetailsOnOpen: false,
        openAfterCreate: true,
        useTemplate: true
      }
    })
    const { result } = renderHook(() => useChecksPanelCreateReview(input))

    await act(async () => result.current.handleCreatePullRequest(false))

    expect(input.setRightSidebarTab).toHaveBeenCalledWith('checks')
    expect(openHttpLink).toHaveBeenCalledWith('https://github.com/orca/app/pull/42', {
      worktreeId: 'worktree-1'
    })
  })
})
