import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  return { state, listeners }
})

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: vi.fn().mockResolvedValue({ status: 'failed', message: '' }),
  isWebRuntimeSessionActive: () => false
}))
vi.mock('@/lib/workspace-tab-commands', () => ({ dispatchWorkspaceTabCommand: vi.fn() }))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  createFloatingWorkspaceTerminalTab: vi.fn(),
  isFloatingWorkspacePanelFocused: () => false,
  resolveFloatingWorkspaceBrowserWorkspaceId: vi.fn()
}))
vi.mock('@/lib/floating-workspace-guest-bridge', () => ({
  dispatchFloatingWorkspaceGuestClose: vi.fn(),
  dispatchFloatingWorkspaceGuestSelectIndex: vi.fn()
}))

import { registerTabLifecycleIpcBridge } from './tab-lifecycle-ipc-bridge'

const WORKTREE_ID = 'repo-1::/repo/worktree'

describe('registerTabLifecycleIpcBridge new terminal tab', () => {
  beforeEach(() => {
    mocks.listeners = {}
    const ui = new Proxy(
      {},
      {
        get: (_target, name) => (listener: (...args: unknown[]) => void) => {
          mocks.listeners[String(name)] = listener
          return () => {}
        }
      }
    )
    vi.stubGlobal('window', { api: { ui } })
  })

  it('appends the new terminal to the saved order, dropping repeated ids', async () => {
    const setTabBarOrder = vi.fn()
    const terminals = [{ id: 'term-a' }]
    mocks.state = {
      activeWorktreeId: WORKTREE_ID,
      tabsByWorktree: { [WORKTREE_ID]: terminals },
      openFiles: [],
      browserTabsByWorktree: { [WORKTREE_ID]: [{ id: 'browser-1' }] },
      tabBarOrderByWorktree: { [WORKTREE_ID]: ['browser-1', 'term-a', 'browser-1'] },
      createTab: () => {
        terminals.push({ id: 'term-new' })
        return { id: 'term-new' }
      },
      setActiveTabType: vi.fn(),
      setTabBarOrder
    }
    registerTabLifecycleIpcBridge([])
    mocks.listeners.onNewTerminalTab()
    await vi.waitFor(() => expect(setTabBarOrder).toHaveBeenCalled())
    expect(setTabBarOrder).toHaveBeenCalledWith(WORKTREE_ID, ['browser-1', 'term-a', 'term-new'])
  })
})
