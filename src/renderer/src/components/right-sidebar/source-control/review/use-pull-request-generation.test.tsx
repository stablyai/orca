// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeGitGenerationClient from '@/runtime/runtime-git-generation-client'
import type { RuntimeGeneratePullRequestFieldsResult } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'

const runtime = vi.hoisted(() => ({
  cancel: vi.fn().mockResolvedValue(undefined),
  generate: vi.fn()
}))

vi.mock('@/runtime/runtime-git-generation-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeGitGenerationClient>()
  return {
    ...original,
    cancelRuntimeGeneratePullRequestFields: runtime.cancel,
    generateRuntimePullRequestFields: runtime.generate
  }
})

import { useSourceControlPullRequestGeneration } from './use-pull-request-generation'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  runtime.cancel.mockReset().mockResolvedValue(undefined)
  runtime.generate.mockReset()
  useAppStore.setState({ pullRequestGenerationRecords: {} })
})

describe('useSourceControlPullRequestGeneration outcome', () => {
  it('captures the owning host’s Jira key before a background generation outlives a workspace switch', async () => {
    const workspace = makeWorktree('wt-1', 'Jira task', {
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'Fix login',
        jiraIdentifier: 'ALT-42',
        url: 'https://jira.example.com/browse/alt-42'
      }
    })
    const lookup = vi
      .spyOn(useAppStore.getState(), 'getKnownWorktreeById')
      .mockReturnValue(workspace)
    let answer: (value: RuntimeGeneratePullRequestFieldsResult) => void = () => {}
    runtime.generate.mockImplementation(
      () =>
        new Promise<RuntimeGeneratePullRequestFieldsResult>((resolve) => {
          answer = resolve
        })
    )
    const state = useAppStore.getState()
    const { result } = renderHook(() =>
      useSourceControlPullRequestGeneration({
        activeRepo: { ...makeRepo(), connectionId: 'owner-host' },
        activeRepoTarget: { kind: 'environment', environmentId: 'owner-environment' },
        activeWorktreeId: 'wt-1',
        allocatePullRequestGenerationRequestId: () => 11,
        branchName: 'user/alt-42-fix-login',
        hostedReviewCreateProvider: 'gitlab',
        prGenerationRecords: {},
        refreshGitStatusAfterPullRequestGeneration: vi.fn(),
        resolvedPrCreationDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
        setPullRequestGenerationRecord: state.setPullRequestGenerationRecord,
        updatePullRequestGenerationRecord: state.updatePullRequestGenerationRecord,
        worktreePath: '/repo/wt'
      })
    )
    const outcome = result.current.handleGeneratePullRequestFieldsForActive(
      { base: 'main', title: 'ALT-42 Fix login', body: '', draft: false },
      { base: 0, title: 0, body: 0, draft: 0 },
      undefined,
      { autoSubmit: true }
    )
    expect(lookup).toHaveBeenCalledWith('wt-1', 'ssh:owner-host')
    lookup.mockReturnValue(makeWorktree('other', 'Unrelated task'))
    answer({
      success: true,
      fields: { base: 'main', title: 'Better login', body: 'Generated', draft: false }
    })
    await expect(outcome).resolves.toMatchObject({ result: { title: 'ALT-42 Better login' } })
  })
})
