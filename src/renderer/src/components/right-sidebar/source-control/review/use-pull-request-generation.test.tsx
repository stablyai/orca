// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGitClient from '@/runtime/runtime-git-client'
import type { RuntimeGeneratePullRequestFieldsResult } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from '../../../../../../shared/source-control-ai-settings'

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

import { useSourceControlPullRequestGeneration } from './use-pull-request-generation'

afterEach(() => {
  cleanup()
  runtime.cancel.mockReset().mockResolvedValue(undefined)
  runtime.generate.mockReset()
  useAppStore.setState({ pullRequestGenerationRecords: {} })
})

describe('useSourceControlPullRequestGeneration outcome', () => {
  it.each([
    { name: 'keeps the base for a Create PR run', autoSubmit: true, base: 'main' },
    { name: 'keeps the agent base for a reviewed run', autoSubmit: false, base: 'develop' }
  ])('$name', async ({ autoSubmit, base }) => {
    const generated = { base: 'develop', title: 'Add feature flag', body: 'Details.', draft: false }
    runtime.generate.mockResolvedValue({ success: true, fields: generated })
    const { setPullRequestGenerationRecord, updatePullRequestGenerationRecord } =
      useAppStore.getState()
    const { result } = renderHook(() =>
      useSourceControlPullRequestGeneration({
        activeRepo: {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        },
        activeRepoSettings: null,
        activeWorktreeId: 'wt-1',
        allocatePullRequestGenerationRequestId: vi.fn(() => 5),
        branchName: 'feature',
        hostedReviewCreateProvider: 'github',
        prGenerationRecords: {},
        refreshGitStatusAfterPullRequestGeneration: vi.fn(),
        resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord,
        worktreePath: '/repo'
      })
    )

    const outcome = await result.current.handleGeneratePullRequestFieldsForActive(
      { base: 'main', title: 'Feature', body: '', draft: false },
      { base: 0, title: 0, body: 0, draft: 0 },
      undefined,
      { autoSubmit }
    )

    expect(outcome).toEqual({ result: { ...generated, base } })
  })

  it("returns no result when a later run replaced this one, not the later run's details", async () => {
    const generationKey = JSON.stringify(['repo-1', 'wt-1', 'feature'])
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
      useSourceControlPullRequestGeneration({
        activeRepo: {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        },
        activeRepoSettings: null,
        activeWorktreeId: 'wt-1',
        allocatePullRequestGenerationRequestId: vi.fn(() => 5),
        branchName: 'feature',
        hostedReviewCreateProvider: 'github',
        prGenerationRecords: {},
        refreshGitStatusAfterPullRequestGeneration: vi.fn(),
        resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord,
        worktreePath: '/repo'
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
      context: { ...stopped!.context, requestId: 6 },
      status: 'succeeded',
      result: { ...fields, title: 'Later run' }
    })
    answer({ success: false, error: 'canceled', canceled: true })

    await expect(outcome).resolves.toEqual({ result: null })
  })

  it('settles with no result as soon as Stop lands, without waiting for the stopped request, and drops its late result', async () => {
    const generationKey = JSON.stringify(['repo-1', 'wt-1', 'feature'])
    let answer: (result: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    // The cancel never reaches the host, so the stopped request stays pending.
    runtime.cancel.mockReturnValue(new Promise(() => {}))
    const subscribe = useAppStore.subscribe
    const released = vi.fn()
    const subscribed = vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe(listener)
      return () => {
        released()
        unsubscribe()
      }
    })
    const { setPullRequestGenerationRecord, updatePullRequestGenerationRecord } =
      useAppStore.getState()
    const { result } = renderHook(() =>
      useSourceControlPullRequestGeneration({
        activeRepo: {
          id: 'repo-1',
          path: '/repo',
          displayName: 'repo',
          badgeColor: '#000',
          addedAt: 0
        },
        activeRepoSettings: null,
        activeWorktreeId: 'wt-1',
        allocatePullRequestGenerationRequestId: vi.fn(() => 5),
        branchName: 'feature',
        hostedReviewCreateProvider: 'github',
        prGenerationRecords: useAppStore((s) => s.pullRequestGenerationRecords),
        refreshGitStatusAfterPullRequestGeneration: vi.fn(),
        resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord,
        worktreePath: '/repo'
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
    // The run's store listener is gone once its outcome settles.
    expect(subscribed).toHaveBeenCalledTimes(1)
    expect(released).toHaveBeenCalledTimes(1)
    subscribed.mockRestore()

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
