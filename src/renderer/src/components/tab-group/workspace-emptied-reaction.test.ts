import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const mocks = vi.hoisted(() => {
  const state = {
    settings: { deleteWorkspaceOnLastTabClose: 'close' as string },
    activeWorktreeId: 'repo::/wt' as string | null,
    activeWorkspaceExecutionHostId: 'local' as string | null,
    worktreesByRepo: {
      repo: [{ id: 'repo::/wt', repoId: 'repo', hostId: 'local', instanceId: 'i1' }]
    },
    folderWorkspaces: [],
    projectGroups: [],
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 0 }),
    setActiveWorktree: vi.fn((id: string | null) => {
      state.activeWorktreeId = id
    })
  }
  return { state, enqueue: vi.fn() }
})

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/last-tab-auto-delete/last-tab-auto-delete-queue', () => ({
  enqueueLastTabAutoDelete: mocks.enqueue
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

import { captureWorkspaceEmptiedReaction } from './workspace-emptied-reaction'

const WT = 'repo::/wt'

describe('captureWorkspaceEmptiedReaction auto-delete', () => {
  beforeEach(() => {
    mocks.enqueue.mockClear()
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.settings = { deleteWorkspaceOnLastTabClose: 'close' }
    mocks.state.activeWorktreeId = WT
  })

  it('queues a delete after an explicit close empties the workspace', () => {
    captureWorkspaceEmptiedReaction(WT)()
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(mocks.enqueue).toHaveBeenCalledWith({
      workspaceKey: WT,
      trigger: 'close',
      wasActive: true,
      hostId: 'local',
      instanceId: 'i1'
    })
  })

  it('still deselects but queues nothing for a close no user asked for', () => {
    captureWorkspaceEmptiedReaction(WT, { autoDeleteEligible: false })()
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('queues nothing while the setting is off', () => {
    mocks.state.settings = { deleteWorkspaceOnLastTabClose: 'off' }
    captureWorkspaceEmptiedReaction(WT)()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('remembers the workspace was active even if the selection clears before the close lands', () => {
    const whenEmptied = captureWorkspaceEmptiedReaction(WT, { trigger: 'exit' })
    mocks.state.setActiveWorktree(null)
    whenEmptied()
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'exit', wasActive: true })
    )
  })

  it('passes the closing tab host through to the capture', () => {
    mocks.state.activeWorktreeId = null
    captureWorkspaceEmptiedReaction(WT, { hostId: 'local' })()
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ wasActive: false, hostId: 'local' })
    )
  })

  it('never queues the floating panel', () => {
    captureWorkspaceEmptiedReaction(FLOATING_TERMINAL_WORKTREE_ID)()
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})
