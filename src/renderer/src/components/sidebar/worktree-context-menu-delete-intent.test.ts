import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runDelete: vi.fn(), runBatchDelete: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./delete-worktree-flow', () => ({
  runWorktreeDelete: mocks.runDelete,
  runWorktreeBatchDelete: mocks.runBatchDelete
}))

import { deferWorktreeContextMenuDeleteIntent } from './worktree-context-menu-delete-intent'

describe('deferWorktreeContextMenuDeleteIntent', () => {
  it('dispatches the selected workspace identity after the menu event completes', () => {
    const defer = vi.fn<(callback: () => void) => void>()
    const intent = {
      kind: 'worktree' as const,
      worktreeId: 'repo::/work/wt',
      worktreeInstanceId: 'instance-1'
    }
    const onDispatched = vi.fn()

    deferWorktreeContextMenuDeleteIntent(intent, onDispatched, defer)

    expect(mocks.runDelete).not.toHaveBeenCalled()
    expect(onDispatched).not.toHaveBeenCalled()
    expect(defer).toHaveBeenCalledOnce()

    const [deferred] = defer.mock.calls[0]
    deferred()

    expect(mocks.runDelete).toHaveBeenCalledWith('repo::/work/wt', {
      expectedInstanceId: 'instance-1'
    })
    expect(onDispatched).toHaveBeenCalledOnce()
  })
})
