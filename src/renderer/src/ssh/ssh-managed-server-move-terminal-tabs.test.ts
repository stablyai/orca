import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshManagedServerMoveResult } from '../../../shared/ssh-managed-server-move'
import {
  bufferPreHandlerPtyExit,
  discardPreHandlerPtyState,
  hasPreHandlerPtyExit
} from '../components/terminal-pane/pty-pre-handler-buffer'
import { createTestStore, makeLayout, makeTab } from '../store/slices/store-test-helpers'

const store = createTestStore()
vi.mock('@/store', () => ({ useAppStore: store }))

const { collectSshTargetTerminalBindings, moveRestartingStoppedTabs } =
  await import('./ssh-managed-server-move-terminal-tabs')

const worktreeId = 'repo-1::/root/repo'
const shellOne = 'ssh:ssh-1@@pty-1'
const shellTwo = 'ssh:ssh-1@@pty-2'
const otherHostShell = 'ssh:ssh-9@@pty-1'
const remount = vi.fn()

beforeEach(() => {
  remount.mockClear()
  for (const ptyId of [shellOne, shellTwo, otherHostShell]) {
    discardPreHandlerPtyState(ptyId)
  }
  store.setState({
    tabsByWorktree: {
      [worktreeId]: [
        makeTab({ id: 'tab-1', worktreeId, ptyId: shellOne }),
        makeTab({ id: 'tab-2', worktreeId, title: 'Terminal 2', ptyId: null }),
        makeTab({ id: 'tab-3', worktreeId, ptyId: otherHostShell })
      ]
    },
    ptyIdsByTabId: { 'tab-1': [shellOne], 'tab-3': [otherHostShell] },
    // A parked tab whose live binding was cleared still names its shell in its layout.
    terminalLayoutsByTabId: {
      'tab-2': { ...makeLayout(), ptyIdsByLeafId: { 'leaf-2': shellTwo } }
    },
    remountTerminalTabForRecovery: remount
  })
})

describe('moving a host restarts only the terminals the move stopped', () => {
  it("finds every shell this host's tabs are bound to, and no other host's", () => {
    expect(collectSshTargetTerminalBindings(store.getState(), 'ssh-1')).toEqual([
      { tabId: 'tab-1', ptyId: shellOne },
      { tabId: 'tab-2', ptyId: shellTwo }
    ])
  })

  it('leaves the tabs to the server once the host moved', async () => {
    await moveRestartingStoppedTabs('ssh-1', async () => ({
      outcome: 'moved',
      environmentId: 'env-1'
    }))
    expect(remount).not.toHaveBeenCalled()
  })

  it.each<SshManagedServerMoveResult>([
    { outcome: 'refused', verdict: 'live', terminals: 1, stoppedPtyIds: [shellTwo] },
    { outcome: 'stayed', stoppedPtyIds: [shellTwo] }
  ])(
    'restarts a parked tab whose shell the move stopped, clearing its buffered exit ($outcome)',
    async (result) => {
      await moveRestartingStoppedTabs('ssh-1', async () => {
        // The parked tab has no pane, so its exit waits in the pre-handler buffer.
        bufferPreHandlerPtyExit(shellTwo, 0)
        return result
      })
      expect(remount.mock.calls).toEqual([['tab-2']])
      // Left buffered, the exit would close the tab the moment it was revealed.
      expect(hasPreHandlerPtyExit(shellTwo)).toBe(false)
    }
  )

  it('never reopens a tab whose shell exited before the move stopped anything', async () => {
    await moveRestartingStoppedTabs('ssh-1', async () => ({ outcome: 'stayed' }))
    expect(remount).not.toHaveBeenCalled()
  })
})
