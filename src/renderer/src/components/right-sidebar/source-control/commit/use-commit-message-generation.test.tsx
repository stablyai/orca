// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGeneration from '@/runtime/runtime-git-generation-client'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { resolveSourceControlAiForOperation } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { getDefaultSourceControlAiSettings } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type { CreatePrIntentRunToken } from '../review/create-pr-intent-flow'
import { useSourceControlCreatePrIntentCommitMessage } from '../review/use-create-pr-intent-commit-message'
import { useSourceControlCommitMessageGeneration } from './use-commit-message-generation'

const runtime = vi.hoisted(() => ({
  generate: vi.fn<typeof RuntimeGeneration.generateRuntimeCommitMessage>(),
  cancel: vi.fn<typeof RuntimeGeneration.cancelRuntimeGenerateCommitMessage>()
}))
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  generateRuntimeCommitMessage: runtime.generate,
  cancelRuntimeGenerateCommitMessage: runtime.cancel
}))

type GenerationInput = Parameters<typeof useSourceControlCommitMessageGeneration>[0]
const overrides = { sourceControlAiResolvedParams: { agentId: 'codex' as const, model: 'gpt-5.5' } }

function input(): GenerationInput {
  const store = useAppStore.getState()
  return {
    activeRepo: null,
    activeRepoTarget: { kind: 'environment', environmentId: 'original-owner' },
    activeWorktreeId: 'wt-1',
    allocateCommitMessageGenerationRequestId: store.allocateCommitMessageGenerationRequestId,
    commitMessageGenerationRecords: {},
    createPrIntentRunTokenRef: { current: {} },
    generateErrors: {},
    generateInFlightByWorktree: {},
    generateInFlightRef: { current: {} },
    openCommitGenerationDialog: vi.fn(),
    resolvedCommitMessageAi: null,
    setCommitMessageGenerationRecord: store.setCommitMessageGenerationRecord,
    setGenerateErrors: vi.fn(),
    setGenerateInFlightByWorktree: vi.fn(),
    settings: null,
    sourceControlAiActionsVisible: true,
    updateCommitDrafts: vi.fn(),
    updateCommitMessageGenerationRecord: store.updateCommitMessageGenerationRecord,
    worktreePath: '/repo/wt'
  }
}

function pendingResult() {
  let resolve: (
    result: Awaited<ReturnType<typeof RuntimeGeneration.generateRuntimeCommitMessage>>
  ) => void = () => {}
  const promise = new Promise<
    Awaited<ReturnType<typeof RuntimeGeneration.generateRuntimeCommitMessage>>
  >((done) => {
    resolve = done
  })
  runtime.generate.mockReturnValue(promise)
  return resolve
}

afterEach(() => {
  cleanup()
  runtime.generate.mockReset()
  runtime.cancel.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({ commitMessageGenerationRecords: {} })
})

describe('commit generation request ownership', () => {
  it('retains the opaque identity and explicit Stop state with the original owner', async () => {
    const answer = pendingResult()
    const model = input()
    const { result, rerender } = renderHook(
      ({ target }) =>
        useSourceControlCommitMessageGeneration({
          ...model,
          activeRepoTarget: target,
          commitMessageGenerationRecords: useAppStore((s) => s.commitMessageGenerationRecords)
        }),
      { initialProps: { target: model.activeRepoTarget } }
    )
    let request: Promise<void> = Promise.resolve()
    act(() => {
      request = result.current.handleGenerate(overrides)
    })
    const context = useAppStore.getState().commitMessageGenerationRecords['wt-1'].context
    expect(context.generationId).toMatch(/^[0-9a-f-]{36}$/)
    const isCanceled = runtime.generate.mock.calls[0][2]
    expect(isCanceled?.()).toBe(false)
    rerender({ target: { kind: 'environment', environmentId: 'new-focus' } })
    act(() => result.current.handleCancelGenerate())
    expect(isCanceled?.()).toBe(true)
    expect(runtime.cancel).toHaveBeenCalledWith({
      target: context.runtimeTarget,
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      connectionId: undefined,
      generationId: context.generationId
    })
    answer({ success: false, error: 'Generation canceled.', canceled: true })
    await act(async () => {
      await request
    })
    expect(useAppStore.getState().commitMessageGenerationRecords['wt-1'].status).toBe('canceled')
  })

  it('keeps an unstopped generation alive across unmount', async () => {
    const answer = pendingResult()
    const model = input()
    const { result, unmount } = renderHook(() => useSourceControlCommitMessageGeneration(model))
    let request: Promise<void> = Promise.resolve()
    act(() => {
      request = result.current.handleGenerate(overrides)
    })
    const isCanceled = runtime.generate.mock.calls[0][2]
    unmount()
    expect(isCanceled?.()).toBe(false)
    expect(runtime.cancel).not.toHaveBeenCalled()
    answer({ success: true, message: 'Feature' })
    await request
    expect(useAppStore.getState().commitMessageGenerationRecords['wt-1']).toMatchObject({
      status: 'succeeded',
      message: 'Feature'
    })
  })

  it('routes the shared Stop button to Create PR intent commit generation without changing its result policy', async () => {
    const answer = pendingResult()
    const model = input()
    const token: CreatePrIntentRunToken = {
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt',
      branch: 'feature',
      provider: 'gitlab',
      pinnedCopy: null,
      startedAt: 1
    }
    model.createPrIntentRunTokenRef.current['wt-1'] = token
    const settings = {
      ...getDefaultSettings('/fixture'),
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        agentId: 'codex' as const,
        actions: { commitMessage: { agentId: 'codex' as const } }
      }
    }
    const resolvedCommitMessageAi = resolveSourceControlAiForOperation({
      settings,
      operation: 'commitMessage'
    })
    expect(resolvedCommitMessageAi.ok).toBe(true)
    const { result } = renderHook(() => ({
      stop: useSourceControlCommitMessageGeneration(model).handleCancelGenerate,
      intent: useSourceControlCreatePrIntentCommitMessage({
        activeRepo: null,
        generateInFlightRef: model.generateInFlightRef,
        getCreatePrIntentOperationTarget: () => ({
          target: model.activeRepoTarget,
          worktreeId: 'wt-1',
          worktreePath: '/repo/wt'
        }),
        resolvedCommitMessageAi,
        setGenerateErrors: model.setGenerateErrors,
        setGenerateInFlightByWorktree: model.setGenerateInFlightByWorktree,
        settings
      })
    }))
    const request = result.current.intent.generateCommitMessageForCreatePrIntent(token)
    const context = token.commitMessageGeneration
    expect(context?.generationId).toMatch(/^[0-9a-f-]{36}$/)
    act(() => result.current.stop())
    expect(runtime.generate.mock.calls[0][2]?.()).toBe(true)
    expect(runtime.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: context?.generationId,
        target: model.activeRepoTarget
      })
    )
    answer({ success: false, error: 'Generation canceled.', canceled: true })
    await expect(request).resolves.toEqual({ ok: false, reason: 'canceled' })
    expect(token.commitMessageGeneration).toBeUndefined()
    expect(useAppStore.getState().commitMessageGenerationRecords).toEqual({})
  })
})
