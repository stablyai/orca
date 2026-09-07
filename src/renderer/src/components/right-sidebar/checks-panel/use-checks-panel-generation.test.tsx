// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGitClient from '@/runtime/runtime-git-client'

const runtime = vi.hoisted(() => ({ cancel: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/runtime/runtime-git-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeGitClient>()
  return { ...original, cancelRuntimeGeneratePullRequestFields: runtime.cancel }
})

import { useChecksPanelGeneration } from './use-checks-panel-generation'

type GenerationInput = Parameters<typeof useChecksPanelGeneration>[0]

afterEach(() => {
  cleanup()
  runtime.cancel.mockReset().mockResolvedValue(undefined)
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
