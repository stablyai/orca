// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  useFullSubmitOrchestration,
  type FullSubmitOrchestrationInput
} from './full-submit-orchestration'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('useFullSubmitOrchestration cancellation', () => {
  it('settles creating but never crosses the irreversible creation boundary after dismissal', async () => {
    const resolution = deferred<{ kind: 'none' }>()
    let cancelled = false
    const executeFullCreation = vi.fn<FullSubmitOrchestrationInput['executeFullCreation']>()
    const setCreating = vi.fn<FullSubmitOrchestrationInput['setCreating']>()
    const state = {
      disabledTuiAgents: [],
      executeFullCreation,
      fallbackDefaultAgent: 'claude',
      isProjectGroupTarget: false,
      isSubmissionCancelled: () => cancelled,
      repoId: 'repo-1',
      requiresExplicitSetupChoice: false,
      resolvePendingSmartGitHubSubmit: () => resolution.promise,
      selectedRepo: {
        id: 'repo-1',
        path: '/repos/repo-1',
        displayName: 'Repo 1',
        badgeColor: '#000000',
        addedAt: 0
      },
      selectedRepoRequiresConnection: false,
      setCreateError: vi.fn<FullSubmitOrchestrationInput['setCreateError']>(),
      setCreating,
      setTuiAgent: vi.fn<FullSubmitOrchestrationInput['setTuiAgent']>(),
      setupDecision: null,
      shouldWaitForIssueAutomationCheck: false,
      shouldWaitForSetupCheck: false,
      showProjectRequiredError: vi.fn<FullSubmitOrchestrationInput['showProjectRequiredError']>(),
      sourceIntentBlocksCreate: false,
      sparseError: null,
      submitFolderTarget: vi.fn<FullSubmitOrchestrationInput['submitFolderTarget']>(),
      tuiAgent: 'claude',
      workspaceSeedName: 'workspace'
    } satisfies FullSubmitOrchestrationInput
    const hook = renderHook(() => useFullSubmitOrchestration(state))

    let submission!: Promise<void>
    act(() => {
      submission = hook.result.current.submit()
    })
    expect(setCreating).toHaveBeenCalledWith(true)

    cancelled = true
    resolution.resolve({ kind: 'none' })
    await act(async () => submission)

    expect(executeFullCreation).not.toHaveBeenCalled()
    expect(setCreating).toHaveBeenLastCalledWith(false)
  })
})
