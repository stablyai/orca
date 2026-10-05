// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGitClient from '@/runtime/runtime-git-client'
import type { RuntimeGeneratePullRequestFieldsResult } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import { resolvePullRequestGenerationCancel } from '@/store/slices/pull-request-generation'

const runtime = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
  generate: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeGitClient>()
  return {
    ...original,
    cancelRuntimeGeneratePullRequestFields: runtime.cancel,
    generateRuntimePullRequestFields: runtime.generate
  }
})

import { useChecksPanelGeneration } from './use-checks-panel-generation'

type GenerationInput = Parameters<typeof useChecksPanelGeneration>[0]

afterEach(() => {
  cleanup()
  runtime.cancel.mockReset().mockResolvedValue(undefined)
  runtime.generate.mockReset()
  useAppStore.setState({ pullRequestGenerationRecords: {} })
})

describe('useChecksPanelGeneration cancellation ownership', () => {
  it('cancels against the captured request owner rather than the focused worktree', () => {
    const record = {
      status: 'running',
      context: {
        requestId: 7,
        worktreeId: 'owner-worktree',
        worktreePath: '/workspace/owner',
        connectionId: 'ssh-owner',
        repoId: 'repo-1',
        branch: 'feature',
        runtimeTargetSettings: { activeRuntimeEnvironmentId: 'runtime-owner' }
      },
      seed: { base: 'main', title: '', body: '', draft: false },
      seedFieldRevisions: { base: 0, title: 0, body: 0, draft: 0 },
      requiresPushBeforeCreate: false,
      result: null,
      error: null,
      hydrated: false
    } satisfies NonNullable<GenerationInput['activePullRequestGenerationRecord']>
    const updateRecord: GenerationInput['updatePullRequestGenerationRecord'] = vi.fn()
    const input: GenerationInput = {
      activePullRequestGenerationKey: 'repo-1::owner-worktree',
      activePullRequestGenerationRecord: record,
      activeWorktreeId: 'currently-focused-worktree',
      activeWorktreePath: '/workspace/current',
      allocatePullRequestGenerationRequestId: vi.fn(() => 8),
      branch: 'feature',
      handleBranchChangedByPullRequestGeneration: vi.fn(),
      hostedReviewCreateProvider: 'github',
      ownerSettings: null,
      prCreationDefaults: {
        draft: false,
        generateDetailsOnOpen: false,
        openAfterCreate: false,
        useTemplate: true
      },
      prGenerationRecords: { 'repo-1::owner-worktree': record },
      repo: { id: 'repo-1', path: '/workspace/current' } as NonNullable<GenerationInput['repo']>,
      setPullRequestGenerationRecord: vi.fn(),
      updatePullRequestGenerationRecord: updateRecord
    }
    const { result } = renderHook(() => useChecksPanelGeneration(input))

    act(() => result.current.handleCancelGeneratePullRequestFieldsForActive())

    expect(runtime.cancel).toHaveBeenCalledWith({
      settings: record.context.runtimeTargetSettings,
      worktreeId: 'owner-worktree',
      worktreePath: '/workspace/owner',
      connectionId: 'ssh-owner'
    })
    expect(updateRecord).toHaveBeenCalledWith('repo-1::owner-worktree', expect.any(Function))
  })
})

describe('useChecksPanelGeneration outcome', () => {
  it.each([
    { name: 'keeps the base for a Create PR run', autoSubmit: true, stop: false, base: 'main' },
    {
      name: 'keeps the agent base for a reviewed run',
      autoSubmit: false,
      stop: false,
      base: 'develop'
    },
    { name: 'returns no result when Stop lands first', autoSubmit: true, stop: true, base: null }
  ])('$name', async ({ autoSubmit, stop, base }) => {
    const generationKey = 'repo-1::worktree-1::feature'
    let answer: (result: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    const { setPullRequestGenerationRecord, updatePullRequestGenerationRecord } =
      useAppStore.getState()
    const input: GenerationInput = {
      activePullRequestGenerationKey: generationKey,
      activePullRequestGenerationRecord: null,
      activeWorktreeId: 'worktree-1',
      activeWorktreePath: '/workspace/repo',
      allocatePullRequestGenerationRequestId: vi.fn(() => 11),
      branch: 'feature',
      handleBranchChangedByPullRequestGeneration: vi.fn(),
      hostedReviewCreateProvider: 'github',
      ownerSettings: null,
      prCreationDefaults: {
        draft: false,
        generateDetailsOnOpen: false,
        openAfterCreate: false,
        useTemplate: true
      },
      prGenerationRecords: {},
      repo: {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      },
      setPullRequestGenerationRecord,
      updatePullRequestGenerationRecord
    }
    const { result } = renderHook(() => useChecksPanelGeneration(input))
    const fields = { base: 'main', title: 'Feature', body: '', draft: false }

    const outcome = result.current.handleGeneratePullRequestFieldsForActive(
      fields,
      { base: 0, title: 0, body: 0, draft: 0 },
      undefined,
      { autoSubmit }
    )
    if (stop) {
      updatePullRequestGenerationRecord(generationKey, resolvePullRequestGenerationCancel)
    }
    const generated = { base: 'develop', title: 'Add feature flag', body: 'Details.', draft: false }
    answer({ success: true, fields: generated })

    await expect(outcome).resolves.toEqual({ result: base ? { ...generated, base } : null })
  })

  it("returns no result when a later run replaced this one, not the later run's details", async () => {
    const generationKey = 'repo-1::worktree-1::feature'
    let answer: (result: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    const { setPullRequestGenerationRecord, updatePullRequestGenerationRecord } =
      useAppStore.getState()
    const { result } = renderHook(() =>
      useChecksPanelGeneration({
        activePullRequestGenerationKey: generationKey,
        activePullRequestGenerationRecord: null,
        activeWorktreeId: 'worktree-1',
        activeWorktreePath: '/workspace/repo',
        allocatePullRequestGenerationRequestId: vi.fn(() => 11),
        branch: 'feature',
        handleBranchChangedByPullRequestGeneration: vi.fn(),
        hostedReviewCreateProvider: 'github',
        ownerSettings: null,
        prCreationDefaults: {
          draft: false,
          generateDetailsOnOpen: false,
          openAfterCreate: false,
          useTemplate: true
        },
        prGenerationRecords: {},
        repo: {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        },
        setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord
      })
    )
    const fields = { base: 'main', title: 'Feature', body: '', draft: false }

    const outcome = result.current.handleGeneratePullRequestFieldsForActive(
      fields,
      { base: 0, title: 0, body: 0, draft: 0 },
      undefined,
      { autoSubmit: true }
    )
    // Stop, then a Generate click whose run finishes before the stopped one winds down.
    const stopped = useAppStore.getState().pullRequestGenerationRecords[generationKey]
    expect(stopped?.status).toBe('running')
    setPullRequestGenerationRecord(generationKey, {
      ...stopped!,
      context: { ...stopped!.context, requestId: 12 },
      status: 'succeeded',
      result: { ...fields, title: 'Later run' }
    })
    answer({ success: false, error: 'canceled', canceled: true })

    await expect(outcome).resolves.toEqual({ result: null })
  })

  it('settles with no result as soon as Stop lands, without waiting for the stopped request, and drops its late result', async () => {
    const generationKey = 'repo-1::worktree-1::feature'
    let answer: (result: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    // The cancel never reaches the host, so the stopped request stays pending.
    runtime.cancel.mockReturnValue(new Promise(() => {}))
    const { setPullRequestGenerationRecord, updatePullRequestGenerationRecord } =
      useAppStore.getState()
    const { result } = renderHook(() =>
      useChecksPanelGeneration({
        activePullRequestGenerationKey: generationKey,
        activePullRequestGenerationRecord: null,
        activeWorktreeId: 'worktree-1',
        activeWorktreePath: '/workspace/repo',
        allocatePullRequestGenerationRequestId: vi.fn(() => 11),
        branch: 'feature',
        handleBranchChangedByPullRequestGeneration: vi.fn(),
        hostedReviewCreateProvider: 'github',
        ownerSettings: null,
        prCreationDefaults: {
          draft: false,
          generateDetailsOnOpen: false,
          openAfterCreate: false,
          useTemplate: true
        },
        prGenerationRecords: useAppStore((s) => s.pullRequestGenerationRecords),
        repo: {
          id: 'repo-1',
          path: '/workspace/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        },
        setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord
      })
    )
    let outcome: Promise<unknown> = Promise.resolve()
    act(() => {
      outcome = result.current.handleGeneratePullRequestFieldsForActive(
        { base: 'main', title: 'Feature', body: '', draft: false },
        { base: 0, title: 0, body: 0, draft: 0 },
        undefined,
        { autoSubmit: true }
      )
    })

    act(() => result.current.handleCancelGeneratePullRequestFieldsForActive())
    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    const stillPending = new Promise((resolve) => setTimeout(() => resolve('still pending'), 50))
    await expect(Promise.race([outcome, stillPending])).resolves.toEqual({ result: null })

    answer({
      success: true,
      fields: { base: 'develop', title: 'Late run', body: 'Late.', draft: false }
    })
    await act(async () => {})
    expect(useAppStore.getState().pullRequestGenerationRecords[generationKey]).toMatchObject({
      status: 'canceled',
      result: null
    })
  })
})
