import { describe, expect, it, vi } from 'vitest'

import { runComposerInitialCommitAction } from './composer-initial-commit-action'

describe('runComposerInitialCommitAction', () => {
  it('sets pending, clears the error, stores the base ref, and resubmits with it', async () => {
    const pending: boolean[] = []
    const setPending = vi.fn((value: boolean) => pending.push(value))
    const setCreateError = vi.fn()
    const setBaseBranch = vi.fn()
    const resubmit = vi.fn().mockResolvedValue(undefined)

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockResolvedValue({ ok: true, baseRef: 'trunk' }),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => false,
      setPending,
      setCreateError,
      setBaseBranch,
      resubmit
    })

    expect(pending).toEqual([true, false])
    expect(setCreateError).toHaveBeenCalledWith(null)
    expect(setBaseBranch).toHaveBeenCalledWith('trunk')
    expect(resubmit).toHaveBeenCalledWith('trunk')
  })

  it('threads the explicit base ref into a quick-create resubmit callback', async () => {
    const quickSubmit = vi.fn().mockResolvedValue(undefined)
    const quickAgent = 'codex'

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockResolvedValue({ ok: true, baseRef: 'develop' }),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => false,
      setPending: vi.fn(),
      setCreateError: vi.fn(),
      setBaseBranch: vi.fn(),
      resubmit: (baseRef) => quickSubmit(quickAgent, baseRef)
    })

    expect(quickSubmit).toHaveBeenCalledWith(quickAgent, 'develop')
  })

  it('renders the returned failure and does not retry workspace creation', async () => {
    const setCreateError = vi.fn()
    const resubmit = vi.fn()

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockResolvedValue({ ok: false, error: 'identity missing' }),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => false,
      setPending: vi.fn(),
      setCreateError,
      setBaseBranch: vi.fn(),
      resubmit
    })

    expect(setCreateError).toHaveBeenCalledWith({
      title: 'Could not create initial commit',
      message: 'identity missing'
    })
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('renders thrown createInitialCommit errors and does not retry workspace creation', async () => {
    const setCreateError = vi.fn()
    const resubmit = vi.fn()

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockRejectedValue(new Error('transport down')),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => false,
      setPending: vi.fn(),
      setCreateError,
      setBaseBranch: vi.fn(),
      resubmit
    })

    expect(setCreateError).toHaveBeenCalledWith({
      title: 'Could not create initial commit',
      message: 'transport down'
    })
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('skips resubmit when workspace creation is already in flight', async () => {
    const setCreateError = vi.fn()
    const setBaseBranch = vi.fn()
    const resubmit = vi.fn()

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockResolvedValue({ ok: true, baseRef: 'main' }),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => true,
      setPending: vi.fn(),
      setCreateError,
      setBaseBranch,
      resubmit
    })

    expect(setCreateError).not.toHaveBeenCalledWith(null)
    expect(setBaseBranch).not.toHaveBeenCalled()
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('skips resubmit when the selected repo changed after the error', async () => {
    const setCreateError = vi.fn()
    const setBaseBranch = vi.fn()
    const resubmit = vi.fn()

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockResolvedValue({ ok: true, baseRef: 'main' }),
      getCurrentRepoId: () => 'repo-2',
      isSubmitInFlight: () => false,
      setPending: vi.fn(),
      setCreateError,
      setBaseBranch,
      resubmit
    })

    expect(setCreateError).not.toHaveBeenCalledWith(null)
    expect(setBaseBranch).not.toHaveBeenCalled()
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('drops a late failure when the selected repo changed mid-action', async () => {
    const setCreateError = vi.fn()
    const resubmit = vi.fn()
    let currentRepoId = 'repo-1'

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockImplementation(async () => {
        currentRepoId = 'repo-2'
        return { ok: false, error: 'identity missing' }
      }),
      getCurrentRepoId: () => currentRepoId,
      isSubmitInFlight: () => false,
      setPending: vi.fn(),
      setCreateError,
      setBaseBranch: vi.fn(),
      resubmit
    })

    expect(setCreateError).not.toHaveBeenCalled()
    expect(resubmit).not.toHaveBeenCalled()
  })

  it('skips post-await state writes and resubmit when cancelled after the commit', async () => {
    const setPending = vi.fn()
    const setCreateError = vi.fn()
    const setBaseBranch = vi.fn()
    const resubmit = vi.fn()
    let cancelled = false

    await runComposerInitialCommitAction({
      sourceRepoId: 'repo-1',
      createInitialCommit: vi.fn().mockImplementation(async () => {
        cancelled = true
        return { ok: true, baseRef: 'main' }
      }),
      getCurrentRepoId: () => 'repo-1',
      isSubmitInFlight: () => false,
      isCancelled: () => cancelled,
      setPending,
      setCreateError,
      setBaseBranch,
      resubmit
    })

    expect(setPending).toHaveBeenCalledTimes(1)
    expect(setPending).toHaveBeenCalledWith(true)
    expect(setCreateError).not.toHaveBeenCalled()
    expect(setBaseBranch).not.toHaveBeenCalled()
    expect(resubmit).not.toHaveBeenCalled()
  })
})
