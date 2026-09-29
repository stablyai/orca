import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toast } from 'sonner'
import { cancelActiveWorktreeCreation } from './worktree-creation-attempt'
import { withWorktreeCreationCancellation } from './worktree-creation-cancellation'
import { WORKTREE_INSTANCE_REPLACED_ERROR } from '@/store/slices/worktree-removal-options'

const state = vi.hoisted(
  (): { pendingWorktreeCreations: Record<string, unknown>; removeWorktree: Mock } => ({
    pendingWorktreeCreations: {},
    removeWorktree: vi.fn()
  })
)
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const worktree = makeWorktree({
  id: 'repo::/workspace',
  repoId: 'repo',
  hostId: 'ssh:owner',
  instanceId: 'instance-1'
})
beforeEach(() => {
  vi.clearAllMocks()
  state.pendingWorktreeCreations = { creation: {}, other: {} }
  state.removeWorktree.mockResolvedValue({ ok: true })
})

describe('worktree creation cancellation', () => {
  it('does no extra deletion or runtime cleanup after a normal handoff', async () => {
    const cleanup = vi.fn()
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
      attempt.cleanupRuntime = cleanup
      attempt.completed = true
      delete state.pendingWorktreeCreations.creation
    })
    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
  })

  it('does not start an already dismissed preparation', async () => {
    delete state.pendingWorktreeCreations.creation
    const execute = vi.fn()
    await withWorktreeCreationCancellation('creation', execute)
    expect(execute).not.toHaveBeenCalled()
    expect(state.removeWorktree).not.toHaveBeenCalled()
  })

  it('waits for creation to settle and removes only its captured host, once', async () => {
    const gate = deferred()
    const cleanup = vi.fn()
    const running = withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.cleanupRuntime = cleanup
      await gate.promise
      attempt.worktree = worktree
    })
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    delete state.pendingWorktreeCreations.creation
    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    gate.resolve()
    await running
    expect(state.removeWorktree).toHaveBeenCalledExactlyOnceWith(
      { id: worktree.id, executionHostId: 'ssh:owner' },
      true,
      {
        skipArchiveHooks: true,
        suppressPreservedBranchToast: true,
        expectedInstanceId: 'instance-1'
      }
    )
    expect(cleanup).toHaveBeenCalledOnce()
    expect(state.pendingWorktreeCreations.other).toBeDefined()
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
  })

  it('keeps cancellation sticky if another pending entry reuses the id', async () => {
    const gate = deferred()
    const running = withWorktreeCreationCancellation('creation', async (attempt) => {
      await gate.promise
      expect(attempt.isCancelled()).toBe(true)
      attempt.worktree = worktree
    })
    cancelActiveWorktreeCreation('creation')
    state.pendingWorktreeCreations.creation = { replacement: true }
    gate.resolve()
    await running
    expect(state.removeWorktree).toHaveBeenCalledOnce()
    expect(state.pendingWorktreeCreations.creation).toEqual({ replacement: true })
  })

  it('ignores duplicate starts while creation or cleanup is still running', async () => {
    const gate = deferred()
    const running = withWorktreeCreationCancellation('creation', async () => {
      await gate.promise
    })
    const duplicate = vi.fn()
    await withWorktreeCreationCancellation('creation', duplicate)
    expect(duplicate).not.toHaveBeenCalled()
    gate.resolve()
    await running
  })

  it('releases ownership after failure', async () => {
    await expect(
      withWorktreeCreationCancellation('creation', async () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
    const execute = vi.fn()
    await withWorktreeCreationCancellation('creation', execute)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('cleans up a settled post-create failure when its error panel is dismissed', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    await vi.waitFor(() => expect(state.removeWorktree).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(cancelActiveWorktreeCreation('creation')).toBe(false))
  })

  it('retires a settled workspace before retry dispatch and blocks retry on failed cleanup', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    const events: string[] = []
    state.removeWorktree.mockImplementationOnce(async () => {
      events.push('remove')
      return { ok: true }
    })
    await withWorktreeCreationCancellation('creation', async () => {
      events.push('create')
    })
    expect(events).toEqual(['remove', 'create'])
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    state.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'Host unavailable' })
    const retry = vi.fn()
    await expect(withWorktreeCreationCancellation('creation', retry)).rejects.toThrow(
      'Could not clean up'
    )
    expect(retry).not.toHaveBeenCalled()
  })

  it('releases the attempt and reports a runtime cleanup failure', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.cleanupRuntime = async () => {
        throw new Error('Runtime cleanup failed')
      }
      cancelActiveWorktreeCreation('creation')
    })
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Runtime cleanup failed'), {
      duration: Infinity
    })
  })

  it('reports failed cleanup and retains the runtime when the host cannot confirm deletion', async () => {
    const cleanup = vi.fn()
    state.removeWorktree.mockResolvedValue({ ok: false, error: 'Host unavailable' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
      attempt.cleanupRuntime = cleanup
      cancelActiveWorktreeCreation('creation')
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Host unavailable'),
      expect.objectContaining({ duration: Infinity })
    )
    // The retained runtime is invisible otherwise, so the toast must say how to release it.
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('deleting the workspace releases it'),
      expect.anything()
    )
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
  })

  it('omits the runtime hint when the cancelled creation had no runtime', async () => {
    state.removeWorktree.mockResolvedValue({ ok: false, error: 'Host unavailable' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
      cancelActiveWorktreeCreation('creation')
    })
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining('runtime is still running'),
      expect.anything()
    )
  })

  it('warns instead of claiming a clean rollback when the host never confirmed', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.createOutcomeUnknown = true
      cancelActiveWorktreeCreation('creation')
    })
    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('delete it manually'))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('stays silent when cancellation is known to have preceded the create', async () => {
    await withWorktreeCreationCancellation('creation', async () => {
      cancelActiveWorktreeCreation('creation')
    })
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('treats a replaced instance as nothing left to roll back, not a cleanup failure', async () => {
    const cleanup = vi.fn()
    state.removeWorktree.mockResolvedValue({
      ok: false,
      error: WORKTREE_INSTANCE_REPLACED_ERROR
    })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
      attempt.cleanupRuntime = cleanup
      cancelActiveWorktreeCreation('creation')
    })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('refuses a deferred rollback the host left unidentifiable rather than force-deleting', async () => {
    const unstamped = makeWorktree({ id: 'repo::/workspace', repoId: 'repo', hostId: 'ssh:owner' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = unstamped
    })
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Delete it manually'),
        expect.objectContaining({ duration: Infinity })
      )
    )
    expect(state.removeWorktree).not.toHaveBeenCalled()
  })

  it('still rolls back an unidentifiable workspace when cancelled in flight', async () => {
    const unstamped = makeWorktree({ id: 'repo::/workspace', repoId: 'repo', hostId: 'ssh:owner' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = unstamped
      cancelActiveWorktreeCreation('creation')
    })
    // In-flight cancellation cannot race a replacement, so it must not fail closed.
    expect(state.removeWorktree).toHaveBeenCalledOnce()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps blocking retry until a failed deferred rollback actually removes its workspace', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    state.removeWorktree.mockResolvedValue({ ok: false, error: 'Host unavailable' })

    const firstRetry = vi.fn()
    await expect(withWorktreeCreationCancellation('creation', firstRetry)).rejects.toThrow(
      'Could not clean up'
    )
    expect(firstRetry).not.toHaveBeenCalled()

    // The workspace still exists, so the obligation must survive the first retry
    // rather than letting the next one create a second workspace beside it.
    const secondRetry = vi.fn()
    await expect(withWorktreeCreationCancellation('creation', secondRetry)).rejects.toThrow(
      'Could not clean up'
    )
    expect(secondRetry).not.toHaveBeenCalled()

    state.removeWorktree.mockResolvedValue({ ok: true })
    const finalRetry = vi.fn()
    await withWorktreeCreationCancellation('creation', finalRetry)
    expect(finalRetry).toHaveBeenCalledOnce()
  })

  it('does not arm an unreachable cleanup when a dismissal rollback fails', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    state.removeWorktree.mockResolvedValue({ ok: false, error: 'Host unavailable' })
    // Dismissal removes the pending entry first, so nothing could ever invoke a
    // re-armed hook again — holding the attempt would strand it for the session.
    delete state.pendingWorktreeCreations.creation
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    await vi.waitFor(() => expect(state.removeWorktree).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(cancelActiveWorktreeCreation('creation')).toBe(false))
  })

  it('lets retry proceed once an unidentifiable workspace has been reported', async () => {
    const unstamped = makeWorktree({ id: 'repo::/workspace', repoId: 'repo', hostId: 'ssh:owner' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = unstamped
    })
    const blocked = vi.fn()
    await expect(withWorktreeCreationCancellation('creation', blocked)).rejects.toThrow(
      'Could not clean up'
    )
    // No removal was attempted, so retrying can never discharge it — do not
    // block the user forever behind an obligation nothing can satisfy.
    const retry = vi.fn()
    await withWorktreeCreationCancellation('creation', retry)
    expect(retry).toHaveBeenCalledOnce()
    expect(state.removeWorktree).not.toHaveBeenCalled()
  })

  it('lets retry proceed after the rollback found its workspace already replaced', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.worktree = worktree
    })
    state.removeWorktree.mockResolvedValueOnce({
      ok: false,
      error: WORKTREE_INSTANCE_REPLACED_ERROR
    })
    const retry = vi.fn()
    await withWorktreeCreationCancellation('creation', retry)
    expect(retry).toHaveBeenCalledOnce()
  })
})
