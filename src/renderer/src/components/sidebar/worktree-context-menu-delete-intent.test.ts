import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runDelete: vi.fn(), runBatchDelete: vi.fn() }))

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('./delete-worktree-flow', () => ({
  runWorktreeDelete: mocks.runDelete,
  runWorktreeBatchDelete: mocks.runBatchDelete
}))

import {
  createWorktreeContextMenuDeleteIntent,
  deferWorktreeContextMenuDeleteIntent,
  runWorktreeContextMenuDeleteIntent
} from './worktree-context-menu-delete-intent'

describe('createWorktreeContextMenuDeleteIntent', () => {
  it('routes a same-id row through the host that owns the context menu', () => {
    const local = { id: 'shared', instanceId: 'local-instance', hostId: 'local' as const }
    const ssh = { id: 'shared', instanceId: 'ssh-instance', hostId: 'ssh:box' as const }
    const intent = createWorktreeContextMenuDeleteIntent({
      worktree: ssh,
      batchDeleteWorktrees: [local, ssh],
      isMultiContext: false
    })

    runWorktreeContextMenuDeleteIntent(intent)

    expect(mocks.runDelete).toHaveBeenCalledWith('shared', {
      expectedInstanceId: 'ssh-instance',
      expectedHostId: 'ssh:box'
    })
  })

  it('keeps every selected host in a colliding batch', () => {
    const worktrees = [
      { id: 'shared', instanceId: 'local-instance', hostId: 'local' as const },
      { id: 'shared', instanceId: 'ssh-instance', hostId: 'ssh:box' as const }
    ]
    const intent = createWorktreeContextMenuDeleteIntent({
      worktree: worktrees[1],
      batchDeleteWorktrees: worktrees,
      isMultiContext: true
    })

    runWorktreeContextMenuDeleteIntent(intent)

    expect(mocks.runBatchDelete).toHaveBeenCalledWith(worktrees)
  })
})

describe('deferWorktreeContextMenuDeleteIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('dispatches the selected workspace identity after the menu event completes', () => {
    const defer = vi.fn<(callback: () => void) => void>()
    const intent = {
      kind: 'worktree' as const,
      worktree: { id: 'repo::/work/wt', instanceId: 'instance-1' }
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

  it('preserves every selected workspace identity for batch validation', () => {
    const intent = {
      kind: 'batch' as const,
      worktrees: [
        { id: 'wt-1', instanceId: 'instance-1' },
        { id: 'wt-2', instanceId: 'instance-2' }
      ]
    }

    deferWorktreeContextMenuDeleteIntent(intent, undefined, (callback) => callback())

    expect(mocks.runBatchDelete).toHaveBeenCalledWith(intent.worktrees)
  })

  it('dispatches on the next macrotask by default', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout })
    const intent = {
      kind: 'worktree' as const,
      worktree: { id: 'wt-1', instanceId: 'instance-1' }
    }

    deferWorktreeContextMenuDeleteIntent(intent)

    expect(mocks.runDelete).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(mocks.runDelete).toHaveBeenCalledWith('wt-1', {
      expectedInstanceId: 'instance-1'
    })
  })
})
