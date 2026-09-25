import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  TEST_REPO,
  createTestStore,
  makeTab,
  makeWorktree,
  seedStore
} from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn<() => unknown[]>(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const mockApi = createStoreCascadesMockApi()
const closeTerminalSurface = vi.fn()
Object.assign(mockApi, { session: { closeTerminalSurface } })

const SSH_WORKTREE = 'remote-repo::/srv/app'
const SSH_PTY = 'ssh:target@@pty2:1:1'

function storeWithSshTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ ...TEST_REPO, id: 'remote-repo', path: '/srv/app', connectionId: 'ssh-1' }],
    worktreesByRepo: {
      'remote-repo': [makeWorktree({ id: SSH_WORKTREE, repoId: 'remote-repo', path: '/srv/app' })]
    },
    tabsByWorktree: {
      [SSH_WORKTREE]: [makeTab({ id: 'ssh-tab', worktreeId: SSH_WORKTREE, ptyId: SSH_PTY })]
    },
    ptyIdsByTabId: { 'ssh-tab': [SSH_PTY] }
  })
  return store
}

describe('closeTab close intent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    closeTerminalSurface.mockResolvedValue(undefined)
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('commits the close in main even when the SSH shutdown throws', async () => {
    mockApi.pty.kill.mockRejectedValue(new Error('relay shutdown failed'))
    const store = storeWithSshTab()

    store.getState().closeTab('ssh-tab')
    await Promise.resolve()

    expect(mockApi.pty.kill).toHaveBeenCalledWith(SSH_PTY)
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: SSH_WORKTREE,
      tabId: 'ssh-tab'
    })
  })

  it.each([['user'], ['cleanup']] as const)('sends the intent for a %s close', (reason) => {
    storeWithSshTab().getState().closeTab('ssh-tab', { reason })

    expect(closeTerminalSurface).toHaveBeenCalledTimes(1)
  })

  // Why: exits still retire through main's own exit handling until main decides exits itself.
  it('sends nothing for a pty-exit close', () => {
    storeWithSshTab().getState().closeTab('ssh-tab', { reason: 'pty-exit' })

    expect(closeTerminalSurface).not.toHaveBeenCalled()
  })

  it('sends nothing when a paired host owns the close', () => {
    storeWithSshTab().getState().closeTab('ssh-tab', { remoteCloseOwnedByHost: true })

    expect(closeTerminalSurface).not.toHaveBeenCalled()
  })
})
