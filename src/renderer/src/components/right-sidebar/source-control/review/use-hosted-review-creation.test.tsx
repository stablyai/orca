// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGitClient from '@/runtime/runtime-git-client'
import type { RuntimeGeneratePullRequestFieldsResult } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import {
  createRunningPullRequestGenerationRecord,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOptions } from '@/store/slices/pull-request-generation-auto-submit'
import type { PullRequestGenerationOutcome } from '../../create-pull-request-dialog-field-model'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type {
  CreateHostedReviewResult,
  HostedReviewCreationEligibility
} from '../../../../../../shared/hosted-review'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  getDefaultSourceControlAiSettings
} from '../../../../../../shared/source-control-ai-settings'
import { useSourceControlHostedReviewCreation } from './use-hosted-review-creation'
import { useSourceControlHostedReviewEligibility } from './use-hosted-review-eligibility'
import { useSourceControlHostedReviewState } from './use-hosted-review-state'
import { useSourceControlPullRequestGeneration } from './use-pull-request-generation'

const runtime = vi.hoisted(() => ({ cancel: vi.fn(), generate: vi.fn() }))

vi.mock('@/runtime/runtime-git-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeGitClient>()
  return {
    ...original,
    cancelRuntimeGeneratePullRequestFields: runtime.cancel,
    generateRuntimePullRequestFields: runtime.generate
  }
})

type Input = Parameters<typeof useSourceControlHostedReviewCreation>[0]

const generatedFields = {
  base: 'develop',
  title: 'Correct README install steps',
  body: 'Fixes the typo.',
  draft: true
}

const GENERATION_KEY = 'wt-1::repo-1::fix-readme-typo'
const runningRecordFor = (options: PullRequestGenerationOptions = {}) =>
  createRunningPullRequestGenerationRecord(
    {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      requestId: 7,
      repoId: 'repo-1',
      branch: 'fix-readme-typo'
    },
    { base: 'main', title: 'Fix readme typo', body: '', draft: false },
    { base: 0, title: 0, body: 0, draft: 0 },
    options.autoSubmit
  )
const runningRecord = runningRecordFor()

const readyEligibility: HostedReviewCreationEligibility = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  runtime.cancel.mockReset()
  runtime.generate.mockReset()
  useAppStore.setState({ pullRequestGenerationRecords: {}, activeWorktreeId: null })
})

function makeInput(overrides: Partial<Input> = {}): Input {
  const createdReview: CreateHostedReviewResult = {
    ok: true,
    number: 42,
    url: 'https://github.com/o/r/pull/42'
  }
  return {
    activePullRequestGenerationKey: GENERATION_KEY,
    activeRepo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    },
    activeWorktreeId: 'wt-1',
    branchName: 'fix-readme-typo',
    createHostedReview: vi.fn(async () => createdReview),
    createPrInFlightRef: { current: {} },
    createStackedHostedReview: vi.fn(),
    handleGeneratePullRequestFields: generationReturning(generatedFields),
    handlePullRequestCreated: vi.fn(async () => {}),
    hostedReviewCreateCopy: localizedHostedReviewCopy('github'),
    hostedReviewCreateProvider: 'github',
    hostedReviewCreation: readyEligibility,
    prAiGenerationEnabled: true,
    prBase: 'main',
    prBody: '',
    prDraft: false,
    prFieldsAreSeedPlaceholders: true,
    prGenerating: false,
    prTitle: 'Fix readme typo',
    resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
    setCreatePrInFlightByWorktree: vi.fn(),
    setCreatePrIntentNoticeForWorktree: vi.fn(),
    settings: {
      ...getDefaultSettings('/home/test'),
      sourceControlAi: { ...getDefaultSourceControlAiSettings(), agentId: 'cursor' }
    },
    worktreePath: '/repo',
    ...overrides
  }
}

// Like the store-routed generation: the record runs before the first await and settles to the outcome.
function startGeneration(options?: PullRequestGenerationOptions): void {
  useAppStore.getState().setPullRequestGenerationRecord(GENERATION_KEY, runningRecordFor(options))
}
function settleGeneration(
  result: PullRequestGenerationFields | null
): PullRequestGenerationOutcome {
  useAppStore
    .getState()
    .updatePullRequestGenerationRecord(GENERATION_KEY, (record) =>
      result
        ? resolvePullRequestGenerationSuccess({ record, requestId: 7, result })
        : resolvePullRequestGenerationFailure({ record, requestId: 7, error: 'Agent failed' })
    )
  return {
    result: useAppStore.getState().pullRequestGenerationRecords[GENERATION_KEY]?.result ?? null
  }
}
function generationReturning(result: PullRequestGenerationFields | null) {
  return vi.fn(async (_overrides?: unknown, options?: PullRequestGenerationOptions) => {
    startGeneration(options)
    return settleGeneration(result)
  })
}
function deferredGeneration() {
  let finish: (result: PullRequestGenerationFields | null) => void = () => {}
  const generate = vi.fn((_overrides?: unknown, options?: PullRequestGenerationOptions) => {
    startGeneration(options)
    return new Promise<PullRequestGenerationOutcome>((resolve) => {
      finish = (result) => resolve(settleGeneration(result))
    })
  })
  return { generate, finish: (result: PullRequestGenerationFields | null) => finish(result) }
}

describe('useSourceControlHostedReviewCreation', () => {
  it('generates details for untouched placeholders, then creates with them', async () => {
    const input = makeInput()
    const { result } = renderHook(() => useSourceControlHostedReviewCreation(input))

    await act(async () => result.current.handleCreatePullRequest())

    expect(input.handleGeneratePullRequestFields).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        base: 'main',
        title: 'Correct README install steps',
        body: 'Fixes the typo.',
        draft: true
      })
    )
  })

  it('does not create when generation fails, and the next click submits as shown, even after the panel reopens', async () => {
    const input = makeInput({ handleGeneratePullRequestFields: generationReturning(null) })
    const first = renderHook(() => useSourceControlHostedReviewCreation(input))

    await act(async () => first.result.current.handleCreatePullRequest())
    expect(input.createHostedReview).not.toHaveBeenCalled()
    first.unmount()

    const reopened = renderHook(() => useSourceControlHostedReviewCreation(input))
    await act(async () => reopened.result.current.handleCreatePullRequest())
    expect(input.handleGeneratePullRequestFields).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: 'Fix readme typo', body: '' })
    )
  })

  it('starts one run for repeated clicks and creates once', async () => {
    const { generate, finish } = deferredGeneration()
    const input = makeInput({ handleGeneratePullRequestFields: generate })
    const { result } = renderHook(() => useSourceControlHostedReviewCreation(input))

    let firstClick: Promise<void> = Promise.resolve()
    await act(async () => {
      firstClick = result.current.handleCreatePullRequest()
      await result.current.handleCreatePullRequest()
    })
    await act(async () => {
      finish(generatedFields)
      await firstClick
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledTimes(1)
  })

  it('generates for another worktree while the first worktree is still generating', async () => {
    const { generate: generateA, finish: finishA } = deferredGeneration()
    const input = makeInput({ handleGeneratePullRequestFields: generateA })
    const { result, rerender } = renderHook(
      (props: Input) => useSourceControlHostedReviewCreation(props),
      { initialProps: input }
    )

    let clickA: Promise<void> = Promise.resolve()
    act(() => {
      clickA = result.current.handleCreatePullRequest()
    })
    const generateB = vi.fn(async () => ({ result: generatedFields }))
    rerender({
      ...input,
      activePullRequestGenerationKey: 'wt-2::repo-1::add-usage',
      activeWorktreeId: 'wt-2',
      branchName: 'add-usage',
      handleGeneratePullRequestFields: generateB
    })
    await act(async () => result.current.handleCreatePullRequest())
    await act(async () => {
      finishA(null)
      await clickA
    })

    expect(generateB).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: 'Correct README install steps', head: 'add-usage' })
    )
  })

  it('submits as shown when clicked again after Stop', async () => {
    const { generate, finish } = deferredGeneration()
    const input = makeInput({ handleGeneratePullRequestFields: generate })
    const { result } = renderHook(() => useSourceControlHostedReviewCreation(input))

    let firstClick: Promise<void> = Promise.resolve()
    act(() => {
      firstClick = result.current.handleCreatePullRequest()
    })
    useAppStore
      .getState()
      .setPullRequestGenerationRecord(GENERATION_KEY, { ...runningRecord, status: 'canceled' })
    await act(async () => {
      finish(generatedFields)
      await firstClick
    })
    await act(async () => result.current.handleCreatePullRequest())

    expect(generate).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: 'Fix readme typo', body: '' })
    )
  })

  it('still creates the clicked branch PR when the panel closes mid-run', async () => {
    const { generate, finish } = deferredGeneration()
    const input = makeInput({ handleGeneratePullRequestFields: generate })
    const { result, rerender, unmount } = renderHook(
      (props: Input) => useSourceControlHostedReviewCreation(props),
      { initialProps: input }
    )

    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = result.current.handleCreatePullRequest()
    })
    rerender({ ...input, prGenerating: true })
    unmount()
    await act(async () => {
      finish(generatedFields)
      await click
    })

    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ head: 'fix-readme-typo', title: 'Correct README install steps' })
    )
  })

  it.each([
    { name: 'still selected', selectedAtFinish: 'wt-1', reveals: true },
    { name: 'no longer selected', selectedAtFinish: 'wt-2', reveals: false }
  ])(
    'reveals the created PR only when its worktree is $name after the panel closed mid-run',
    async ({ selectedAtFinish, reveals }) => {
      const openUrl = vi.fn()
      vi.stubGlobal('api', { shell: { openUrl } })
      useAppStore.setState({ activeWorktreeId: 'wt-1' })
      const { generate, finish } = deferredGeneration()
      const input = makeInput({
        handleGeneratePullRequestFields: generate,
        resolvedPrCreationDefaults: {
          ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
          openAfterCreate: true
        }
      })
      const { result, unmount } = renderHook(() => useSourceControlHostedReviewCreation(input))

      let click: Promise<void> = Promise.resolve()
      act(() => {
        click = result.current.handleCreatePullRequest()
      })
      unmount()
      useAppStore.setState({ activeWorktreeId: selectedAtFinish })
      await act(async () => {
        finish(generatedFields)
        await click
      })

      expect(input.createHostedReview).toHaveBeenCalledTimes(1)
      expect(input.handlePullRequestCreated).toHaveBeenCalledWith(
        expect.objectContaining({ number: 42 }),
        expect.objectContaining({ worktreeId: 'wt-1', openChecks: reveals })
      )
      expect(openUrl).toHaveBeenCalledTimes(reveals ? 1 : 0)
    }
  )

  it('creates after generation even though generation ending refreshes eligibility', async () => {
    const { generate, finish } = deferredGeneration()
    const base = makeInput({ handleGeneratePullRequestFields: generate })
    // Why: the first probe confirms the branch; any refetch stays pending, as a real one does for a while.
    const getEligibility = vi
      .fn<() => Promise<HostedReviewCreationEligibility>>()
      .mockResolvedValueOnce(readyEligibility)
      .mockReturnValue(new Promise(() => {}))
    // Wires the real eligibility probe to the real create, as the Source Control panel does.
    const { result } = renderHook(() => {
      const [inFlight, setCreatePrInFlightByWorktree] = useState<Record<string, boolean>>({})
      const createPrInFlightRef = useRef<Record<string, boolean>>({})
      const prGenerating = useAppStore(
        (s) => s.pullRequestGenerationRecords[GENERATION_KEY]?.status === 'running'
      )
      const state = useSourceControlHostedReviewState({
        activePrFromQueue: null,
        activeRepoId: 'repo-1',
        activeWorktreeId: 'wt-1',
        branchName: 'fix-readme-typo',
        hostedReviewCacheKey: null,
        hostedReviewEntryData: null,
        linkedPR: null,
        suppressedGitHubPR: null
      })
      useSourceControlHostedReviewEligibility({
        activeRepoConnectionId: null,
        activeRepoExecutionHostId: null,
        activeRepoId: 'repo-1',
        activeRepoPath: '/repo',
        activeWorktreeId: 'wt-1',
        branchName: 'fix-readme-typo',
        effectiveBaseRef: 'main',
        fallbackGitHubPRNumber: null,
        getHostedReviewCreationEligibility: getEligibility,
        hasUncommittedEntries: false,
        isBranchVisible: true,
        isCreatePrIntentInFlight: false,
        isCreatingPr: inFlight['wt-1'] === true,
        isFolder: false,
        linkedAzureDevOpsPR: null,
        linkedBitbucketPR: null,
        linkedGitHubPR: null,
        linkedGitLabMR: null,
        linkedGiteaPR: null,
        prGenerating,
        provisionalHostedReviewProvider: 'github',
        remoteStatus: undefined,
        hostedReviewCreationProviderHintRef: state.hostedReviewCreationProviderHintRef,
        setHostedReviewCreationRequestState: state.setHostedReviewCreationRequestState,
        setHostedReviewCreationState: state.setHostedReviewCreationState,
        worktreePath: '/repo'
      })
      return useSourceControlHostedReviewCreation({
        ...base,
        createPrInFlightRef,
        hostedReviewCreation: state.hostedReviewCreation,
        prGenerating,
        setCreatePrInFlightByWorktree
      })
    })
    await act(async () => {})

    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = result.current.handleCreatePullRequest()
    })
    // A repeated click is refused while the first one is in flight.
    await act(async () => result.current.handleCreatePullRequest())
    // The run's record settles and the panel re-renders before the click's continuation resumes.
    await act(async () => {
      useAppStore
        .getState()
        .updatePullRequestGenerationRecord(GENERATION_KEY, (record) =>
          resolvePullRequestGenerationSuccess({ record, requestId: 7, result: generatedFields })
        )
    })
    await act(async () => {
      finish(generatedFields)
      await click
    })

    expect(base.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: 'Correct README install steps' })
    )
  })

  it.each([
    { name: 'fails', result: null },
    { name: 'creates', result: generatedFields }
  ])('releases the in-flight hold when the run $name', async ({ result }) => {
    const { generate, finish } = deferredGeneration()
    const input = makeInput({ handleGeneratePullRequestFields: generate })
    const { result: hook } = renderHook(() => useSourceControlHostedReviewCreation(input))
    const inFlight = (): boolean | undefined =>
      vi
        .mocked(input.setCreatePrInFlightByWorktree)
        .mock.calls.reduce<Record<string, boolean>>(
          (state, [update]) => (typeof update === 'function' ? update(state) : update),
          {}
        )['wt-1']

    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = hook.current.handleCreatePullRequest()
    })
    expect(inFlight()).toBe(true)
    await act(async () => {
      finish(result)
      await click
    })

    expect(inFlight()).toBe(false)
  })

  it('releases the hold as soon as Stop lands, so the next click submits as shown while the stopped request is still pending', async () => {
    let answer: (result: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    // The cancel never reaches the host, so the stopped request stays pending.
    runtime.cancel.mockReturnValue(new Promise(() => {}))
    const base = makeInput()
    // Wires the real store-routed generation and Stop to the real create and its hold, as the Source Control panel does.
    const { result } = renderHook(() => {
      const [inFlight, setCreatePrInFlightByWorktree] = useState<Record<string, boolean>>({})
      const createPrInFlightRef = useRef<Record<string, boolean>>({})
      const prGenerationRecords = useAppStore((s) => s.pullRequestGenerationRecords)
      const generation = useSourceControlPullRequestGeneration({
        activeRepo: base.activeRepo,
        activeRepoSettings: null,
        activeWorktreeId: 'wt-1',
        allocatePullRequestGenerationRequestId:
          useAppStore.getState().allocatePullRequestGenerationRequestId,
        branchName: 'fix-readme-typo',
        hostedReviewCreateProvider: 'github',
        prGenerationRecords,
        refreshGitStatusAfterPullRequestGeneration: vi.fn(),
        resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        setPullRequestGenerationRecord: useAppStore.getState().setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord: useAppStore.getState().updatePullRequestGenerationRecord,
        worktreePath: '/repo'
      })
      const creation = useSourceControlHostedReviewCreation({
        ...base,
        activePullRequestGenerationKey: generation.activePullRequestGenerationKey,
        createPrInFlightRef,
        handleGeneratePullRequestFields: (overrides, options) =>
          generation.handleGeneratePullRequestFieldsForActive(
            { base: base.prBase, title: base.prTitle, body: base.prBody, draft: base.prDraft },
            { base: 0, title: 0, body: 0, draft: 0 },
            overrides,
            options
          ),
        prGenerating: generation.activePullRequestGenerationRecord?.status === 'running',
        setCreatePrInFlightByWorktree
      })
      return { creation, generation, inFlight: inFlight['wt-1'] === true }
    })

    let firstClick: Promise<void> = Promise.resolve()
    act(() => {
      firstClick = result.current.creation.handleCreatePullRequest()
    })
    expect(runtime.generate).toHaveBeenCalledTimes(1)
    expect(result.current.inFlight).toBe(true)

    await act(async () =>
      result.current.generation.handleCancelGeneratePullRequestFieldsForActive()
    )
    expect(result.current.inFlight).toBe(false)
    await act(async () => result.current.creation.handleCreatePullRequest())

    expect(runtime.generate).toHaveBeenCalledTimes(1)
    expect(base.createHostedReview).toHaveBeenCalledTimes(1)
    expect(base.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: 'Fix readme typo', body: '' })
    )
    // The stopped request's late result creates nothing.
    await act(async () => {
      answer({ success: true, fields: generatedFields })
      await firstClick
    })
    expect(base.createHostedReview).toHaveBeenCalledTimes(1)
  })

  it('creates the clicked branch PR without revealing Checks when the panel moved to another worktree mid-run', async () => {
    const openUrl = vi.fn()
    vi.stubGlobal('api', { shell: { openUrl } })
    useAppStore.setState({ activeWorktreeId: 'wt-1' })
    const { generate, finish } = deferredGeneration()
    const input = makeInput({
      handleGeneratePullRequestFields: generate,
      resolvedPrCreationDefaults: {
        ...DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        openAfterCreate: true
      }
    })
    const { result, rerender } = renderHook(
      (props: Input) => useSourceControlHostedReviewCreation(props),
      { initialProps: input }
    )

    let click: Promise<void> = Promise.resolve()
    act(() => {
      click = result.current.handleCreatePullRequest()
    })
    useAppStore.setState({ activeWorktreeId: 'wt-2' })
    rerender({
      ...input,
      activePullRequestGenerationKey: 'wt-2::repo-1::other-branch',
      activeWorktreeId: 'wt-2',
      branchName: 'other-branch',
      hostedReviewCreation: null
    })
    await act(async () => {
      finish(generatedFields)
      await click
    })

    expect(input.createHostedReview).toHaveBeenCalledTimes(1)
    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ head: 'fix-readme-typo', title: 'Correct README install steps' })
    )
    expect(input.handlePullRequestCreated).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
      expect.objectContaining({ worktreeId: 'wt-1', branch: 'fix-readme-typo', openChecks: false })
    )
    expect(openUrl).not.toHaveBeenCalled()
    const noticeTargets = vi
      .mocked(input.setCreatePrIntentNoticeForWorktree)
      .mock.calls.map(([worktreeId]) => worktreeId)
    expect(new Set(noticeTargets)).toEqual(new Set(['wt-1']))
  })

  it.each([
    { name: 'the fields were edited', overrides: { prFieldsAreSeedPlaceholders: false } },
    { name: 'AI actions are off', overrides: { prAiGenerationEnabled: false } },
    {
      name: 'no PR agent is configured',
      overrides: { settings: getDefaultSettings('/home/test') }
    },
    {
      name: 'generation cannot start',
      overrides: { handleGeneratePullRequestFields: vi.fn(async () => undefined) }
    }
  ])('submits as shown when $name', async ({ overrides }) => {
    const input = makeInput(overrides)
    const { result } = renderHook(() => useSourceControlHostedReviewCreation(input))

    await act(async () => result.current.handleCreatePullRequest())

    expect(input.createHostedReview).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ title: input.prTitle, body: '' })
    )
  })

  it('shows the blocked notice instead of generating when the branch is not ready', async () => {
    const input = makeInput({
      hostedReviewCreation: { ...readyEligibility, canCreate: false, blockedReason: 'needs_push' }
    })
    const { result } = renderHook(() => useSourceControlHostedReviewCreation(input))

    await act(async () => result.current.handleCreatePullRequest())

    expect(input.handleGeneratePullRequestFields).not.toHaveBeenCalled()
    expect(input.createHostedReview).not.toHaveBeenCalled()
    expect(input.setCreatePrIntentNoticeForWorktree).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({ tone: 'destructive' })
    )
  })
})
