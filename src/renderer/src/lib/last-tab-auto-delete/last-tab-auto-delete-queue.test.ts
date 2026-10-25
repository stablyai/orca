import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LastTabAutoDeleteCandidate } from './last-tab-auto-delete-candidate'

const mocks = vi.hoisted(() => {
  type Listener = (state: { activeModal: string }) => void
  const listeners = new Set<Listener>()
  const state = {
    activeModal: 'none',
    settings: { skipDeleteWorktreeConfirm: false } as { skipDeleteWorktreeConfirm: boolean }
  }
  return {
    state,
    store: {
      getState: () => state,
      subscribe: (listener: Listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    setModal(activeModal: string) {
      state.activeModal = activeModal
      for (const listener of Array.from(listeners)) {
        listener(state)
      }
    },
    /** workspaceKey → resolved target, or absent when the filter rejects it. */
    targets: new Map<string, unknown>(),
    runWorktreeDelete: vi.fn((_id: string, _options?: unknown) => Promise.resolve()),
    deleteFolder: vi.fn((..._args: unknown[]) => Promise.resolve(true)),
    getRuntimeGitStatus: vi.fn((..._args: unknown[]) =>
      Promise.resolve({ entries: [] as unknown[] } as Record<string, unknown>)
    ),
    statusTarget: { target: { kind: 'local' }, connectionId: undefined } as unknown
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.store }))
vi.mock('@/components/sidebar/delete-worktree-flow', () => ({
  runWorktreeDelete: mocks.runWorktreeDelete
}))
vi.mock('@/components/sidebar/folder-workspace-delete', () => ({
  deleteFolderWorkspaceUnlessUnsaved: mocks.deleteFolder
}))
vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitStatus: mocks.getRuntimeGitStatus
}))
vi.mock('@/lib/worktree-git-status-target', () => ({
  resolveWorktreeGitStatusTarget: () => mocks.statusTarget
}))
vi.mock('./last-tab-auto-delete-eligibility', () => ({
  resolveLastTabAutoDeleteTarget: (_state: unknown, candidate: LastTabAutoDeleteCandidate) =>
    mocks.targets.get(candidate.workspaceKey) ?? null
}))

import {
  enqueueLastTabAutoDelete,
  resetLastTabAutoDeleteQueueForTest
} from './last-tab-auto-delete-queue'

function addWorktree(id: string, hostId = 'local'): void {
  mocks.targets.set(id, {
    kind: 'worktree',
    worktree: { id, hostId, instanceId: `${id}-i`, path: `/w/${id}` }
  })
}
const candidate = (
  workspaceKey: string,
  extra: Partial<LastTabAutoDeleteCandidate> = {}
): LastTabAutoDeleteCandidate => ({ workspaceKey, trigger: 'close', wasActive: true, ...extra })

async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('enqueueLastTabAutoDelete', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLastTabAutoDeleteQueueForTest()
    mocks.targets.clear()
    mocks.state.activeModal = 'none'
    mocks.state.settings = { skipDeleteWorktreeConfirm: false }
    mocks.runWorktreeDelete.mockReset().mockResolvedValue(undefined)
    mocks.deleteFolder.mockReset().mockResolvedValue(true)
    mocks.getRuntimeGitStatus.mockReset().mockResolvedValue({
      entries: [],
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    })
    mocks.statusTarget = { target: { kind: 'local' }, connectionId: undefined }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the delete on the next tick when no modal is open', async () => {
    addWorktree('a')
    enqueueLastTabAutoDelete(candidate('a'))
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
    await flush()
    expect(mocks.runWorktreeDelete).toHaveBeenCalledWith('a', {
      expectedHostId: 'local',
      expectedInstanceId: 'a-i',
      unprompted: true,
      assertBeforeDispatch: expect.any(Function)
    })
  })

  it('aborts the send when the workspace refilled while the delete was waiting', async () => {
    addWorktree('a')
    enqueueLastTabAutoDelete(candidate('a'))
    await flush()
    const options = mocks.runWorktreeDelete.mock.calls[0]?.[1] as {
      assertBeforeDispatch: () => void
    }
    expect(() => options.assertBeforeDispatch()).not.toThrow()
    mocks.targets.delete('a')
    expect(() => options.assertBeforeDispatch()).toThrow()
  })

  it('waits for an open modal to close', async () => {
    addWorktree('a')
    mocks.state.activeModal = 'settings'
    enqueueLastTabAutoDelete(candidate('a'))
    await flush()
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
    mocks.setModal('none')
    await flush()
    expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
  })

  it('runs a second workspace only after the first one dialog closes', async () => {
    addWorktree('a')
    addWorktree('b')
    mocks.runWorktreeDelete.mockImplementation(async () => {
      mocks.state.activeModal = 'delete-worktree'
    })
    enqueueLastTabAutoDelete(candidate('a'))
    enqueueLastTabAutoDelete(candidate('b'))
    await flush()
    expect(mocks.runWorktreeDelete.mock.calls.map(([id]) => id)).toEqual(['a'])
    mocks.setModal('none')
    await flush()
    expect(mocks.runWorktreeDelete.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  })

  it('collapses duplicates, including a duplicate during its own open dialog', async () => {
    addWorktree('a')
    mocks.runWorktreeDelete.mockImplementation(async () => {
      mocks.state.activeModal = 'delete-worktree'
    })
    enqueueLastTabAutoDelete(candidate('a'))
    enqueueLastTabAutoDelete(candidate('a', { hostId: 'local' }))
    await flush()
    enqueueLastTabAutoDelete(candidate('a'))
    mocks.setModal('none')
    await flush()
    expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
  })

  it('holds a duplicate and the next workspace until a no-dialog delete settles', async () => {
    addWorktree('a')
    addWorktree('b')
    let finish: () => void = () => {}
    mocks.runWorktreeDelete.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    enqueueLastTabAutoDelete(candidate('a'))
    await flush()
    enqueueLastTabAutoDelete(candidate('a'))
    enqueueLastTabAutoDelete(candidate('b'))
    await flush()
    expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
    finish()
    await flush()
    expect(mocks.runWorktreeDelete.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  })

  it('drops a workspace whose tabs came back before the run', async () => {
    addWorktree('a')
    enqueueLastTabAutoDelete(candidate('a'))
    mocks.targets.delete('a')
    await flush()
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
  })

  it('deletes a folder through the folder route with its raw id', async () => {
    mocks.targets.set('folder:f1', {
      kind: 'folder',
      folderWorkspaceId: 'f1',
      executionHostId: 'local'
    })
    enqueueLastTabAutoDelete(candidate('folder:f1'))
    await flush()
    expect(mocks.deleteFolder).toHaveBeenCalledWith(mocks.store.getState, 'f1', 'local')
    expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
  })

  describe('exit with skip-confirm', () => {
    beforeEach(() => {
      mocks.state.settings = { skipDeleteWorktreeConfirm: true }
      addWorktree('a')
    })
    const exit = () => candidate('a', { trigger: 'exit' })
    const forced = expect.objectContaining({
      expectedHostId: 'local',
      expectedInstanceId: 'a-i',
      forceConfirm: true
    })

    it('skips the status check for a close', async () => {
      enqueueLastTabAutoDelete(candidate('a'))
      await flush()
      expect(mocks.getRuntimeGitStatus).not.toHaveBeenCalled()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
    })

    it('deletes a clean worktree without forcing the dialog', async () => {
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledWith(
        'a',
        expect.not.objectContaining({ forceConfirm: true })
      )
    })

    it('forces the dialog for dirty, failed, unconfirmed and untargeted status reads', async () => {
      mocks.getRuntimeGitStatus.mockResolvedValueOnce({ entries: [{ path: 'x' }] })
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenLastCalledWith('a', forced)

      mocks.getRuntimeGitStatus.mockRejectedValueOnce(new Error('boom'))
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(2)
      expect(mocks.runWorktreeDelete).toHaveBeenLastCalledWith('a', forced)

      mocks.getRuntimeGitStatus.mockResolvedValueOnce({ entries: [] })
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(3)
      expect(mocks.runWorktreeDelete).toHaveBeenLastCalledWith('a', forced)

      mocks.statusTarget = null
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(4)
      expect(mocks.runWorktreeDelete).toHaveBeenLastCalledWith('a', forced)
    })

    it('forces the dialog once when the status hangs, ignoring a late answer', async () => {
      let answer: (value: { entries: unknown[] }) => void = () => {}
      mocks.getRuntimeGitStatus.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve))
      )
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
      await flush(10_000)
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
      expect(mocks.runWorktreeDelete).toHaveBeenLastCalledWith('a', forced)
      answer({ entries: [] })
      await flush()
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
    })

    it('drops the delete when a tab opens during the status check', async () => {
      mocks.getRuntimeGitStatus.mockImplementationOnce(async () => {
        mocks.targets.delete('a')
        return { entries: [], upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } }
      })
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
    })

    it('requeues when a modal opens during the status check and asks again after it closes', async () => {
      mocks.getRuntimeGitStatus.mockImplementationOnce(async () => {
        mocks.state.activeModal = 'settings'
        return { entries: [], upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 } }
      })
      enqueueLastTabAutoDelete(exit())
      await flush()
      expect(mocks.runWorktreeDelete).not.toHaveBeenCalled()
      mocks.setModal('none')
      await flush()
      expect(mocks.getRuntimeGitStatus).toHaveBeenCalledTimes(2)
      expect(mocks.runWorktreeDelete).toHaveBeenCalledTimes(1)
    })
  })
})
