import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { toast } from 'sonner'
import {
  cancelActiveWorktreeCreation,
  withWorktreeCreationCancellation
} from './worktree-creation-cancellation'

const state = vi.hoisted(() => ({
  pendingWorktreeCreations: {} as Record<string, unknown>,
  removeWorktree: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const worktree = makeWorktree({ id: 'repo::/workspace', repoId: 'repo', hostId: 'ssh:owner' })
beforeEach(() => {
  vi.clearAllMocks()
  state.pendingWorktreeCreations = { creation: {}, other: {} }
  state.removeWorktree.mockResolvedValue({ ok: true })
})

describe('worktree creation cancellation', () => {
  it('does no extra deletion or runtime cleanup after a normal handoff', async () => {
    const cleanup = vi.fn()
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.onCreated(worktree)
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
      attempt.onCreated(worktree)
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
      { skipArchiveHooks: true, suppressPreservedBranchToast: true }
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
      attempt.onCreated(worktree)
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
      attempt.onCreated(worktree)
    })
    expect(state.removeWorktree).not.toHaveBeenCalled()
    expect(cancelActiveWorktreeCreation('creation')).toBe(true)
    await vi.waitFor(() => expect(state.removeWorktree).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(cancelActiveWorktreeCreation('creation')).toBe(false))
  })

  it('retires a settled workspace before retry dispatch and blocks retry on failed cleanup', async () => {
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.onCreated(worktree)
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
      attempt.onCreated(worktree)
    })
    state.removeWorktree.mockResolvedValueOnce({ ok: false, error: 'Host unavailable' })
    const retry = vi.fn()
    await expect(withWorktreeCreationCancellation('creation', retry)).rejects.toThrow(
      'Could not clean up'
    )
    expect(retry).not.toHaveBeenCalled()
  })

  it('reports failed cleanup and retains the runtime when the host cannot confirm deletion', async () => {
    const cleanup = vi.fn()
    state.removeWorktree.mockResolvedValue({ ok: false, error: 'Host unavailable' })
    await withWorktreeCreationCancellation('creation', async (attempt) => {
      attempt.onCreated(worktree)
      attempt.cleanupRuntime = cleanup
      cancelActiveWorktreeCreation('creation')
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Host unavailable'),
      expect.objectContaining({ duration: Infinity })
    )
    expect(cancelActiveWorktreeCreation('creation')).toBe(false)
  })
})
