// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSourceControlConflictAdvance } from './use-conflict-advance'

const { continueSequencerMock, toastErrorMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  continueSequencerMock: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-git-client', () => ({
  continueRuntimeGitSequencer: (...a: unknown[]) => continueSequencerMock(...a)
}))
vi.mock('./remote-refresh', () => ({ refreshSourceControlAfterRemoteAction: vi.fn() }))

const setAdvanceOperationInFlightByWorktree = vi.fn()
const setRemoteActionErrors = vi.fn()

type AdvanceOptions = Parameters<typeof useSourceControlConflictAdvance>[0]

function setup(overrides: Partial<AdvanceOptions> = {}) {
  return renderHook(() =>
    useSourceControlConflictAdvance({
      activeRepoSettings: null,
      activeWorktreeId: 'wt-1',
      conflictOperation: 'rebase',
      isAdvancingOperation: false,
      isAbortingOperation: false,
      refreshActiveGitStatusAfterMutation: vi.fn(),
      refreshBranchCompareRef: { current: vi.fn() },
      refreshGitHistoryRef: { current: vi.fn() },
      setAdvanceOperationInFlightByWorktree,
      setRemoteActionErrors,
      worktreePath: '/repo',
      ...overrides
    })
  )
}

describe('useSourceControlConflictAdvance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('continues the running operation', async () => {
    const { result } = setup()

    await act(async () => {
      result.current.handleContinueOperation('rebase')
    })

    expect(continueSequencerMock).toHaveBeenCalledWith(expect.anything(), 'rebase')
  })

  it('passes each operation through to the sequencer runner', async () => {
    const merge = setup({ conflictOperation: 'merge' })
    await act(async () => {
      merge.result.current.handleContinueOperation('merge')
    })
    const cherry = setup({ conflictOperation: 'cherry-pick' })
    await act(async () => {
      cherry.result.current.handleContinueOperation('cherry-pick')
    })

    expect(continueSequencerMock).toHaveBeenCalledWith(expect.anything(), 'merge')
    expect(continueSequencerMock).toHaveBeenCalledWith(expect.anything(), 'cherry-pick')
    expect(continueSequencerMock).not.toHaveBeenCalledWith(expect.anything(), 'rebase')
  })

  it('ignores a request for an operation that is no longer the one running', async () => {
    const { result } = setup({ conflictOperation: 'merge' })

    await act(async () => {
      result.current.handleContinueOperation('rebase')
    })

    expect(continueSequencerMock).not.toHaveBeenCalled()
  })

  it('refuses to advance while an abort is already in flight', async () => {
    const { result } = setup({ isAbortingOperation: true })

    await act(async () => {
      result.current.handleContinueOperation('rebase')
    })

    expect(continueSequencerMock).not.toHaveBeenCalled()
  })

  it('surfaces a failure and clears the in-flight flag', async () => {
    continueSequencerMock.mockRejectedValueOnce(new Error('needs merge'))
    const { result } = setup()

    await act(async () => {
      result.current.handleContinueOperation('rebase')
    })

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    // Set true on entry, false in the finally block — a stuck flag would disable the banner forever.
    expect(setAdvanceOperationInFlightByWorktree).toHaveBeenCalledTimes(2)
  })
})
