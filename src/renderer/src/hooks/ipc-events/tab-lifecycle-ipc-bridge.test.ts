import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  const createWebRuntimeSessionTerminal = vi.fn()
  return { state, listeners, createWebRuntimeSessionTerminal }
})

vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
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
    mocks.createWebRuntimeSessionTerminal
      .mockReset()
      .mockResolvedValue({ status: 'failed', message: '' })
  })

  function ownerRows(...hostIds: ('local' | 'runtime:env-b')[]): Record<string, unknown> {
    return {
      repos: hostIds.map((hostId) => ({ id: 'repo-1', executionHostId: hostId })),
      worktreesByRepo: {
        'repo-1': hostIds.map((hostId) => ({
          id: WORKTREE_ID,
          repoId: 'repo-1',
          hostId,
          ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-b' })
        }))
      }
    }
  }

  it('routes both split-group directions through the workspace command', () => {
    registerTabLifecycleIpcBridge([])
    mocks.listeners.onFocusTabGroup(1)
    expect(dispatchWorkspaceTabCommand).toHaveBeenLastCalledWith({
      type: 'focus-group',
      direction: 1
    })
    mocks.listeners.onFocusTabGroup(-1)
    expect(dispatchWorkspaceTabCommand).toHaveBeenLastCalledWith({
      type: 'focus-group',
      direction: -1
    })
    mocks.listeners.onFocusTabGroup(-1, 'source-page')
    expect(dispatchWorkspaceTabCommand).toHaveBeenLastCalledWith({
      type: 'focus-group',
      direction: -1,
      sourcePageId: 'source-page'
    })
  })

  it('appends the new terminal to the saved order, dropping repeated ids', async () => {
    const setTabBarOrder = vi.fn()
    const terminals = [{ id: 'term-a' }]
    mocks.state = {
      ...ownerRows('local'),
      activeWorktreeId: WORKTREE_ID,
      tabsByWorktree: { [WORKTREE_ID]: terminals },
      openFiles: [],
      browserTabsByWorktree: { [WORKTREE_ID]: [{ id: 'browser-1' }] },
      tabBarOrderByWorktree: { [WORKTREE_ID]: ['browser-1', 'term-a', 'browser-1'] },
      createTab: (
        _worktreeId: string,
        _groupId: undefined,
        _shell: undefined,
        options: { id: string }
      ) => {
        terminals.push({ id: options.id })
      },
      setActiveTabType: vi.fn(),
      setTabBarOrder
    }
    registerTabLifecycleIpcBridge([])
    mocks.listeners.onNewTerminalTab()
    await vi.waitFor(() => expect(setTabBarOrder).toHaveBeenCalled())
    expect(setTabBarOrder).toHaveBeenCalledWith(WORKTREE_ID, [
      'browser-1',
      'term-a',
      terminals[1].id
    ])
  })

  it("asks a runtime-owned worktree's host for the terminal", async () => {
    const createTab = vi.fn()
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    mocks.state = { ...ownerRows('runtime:env-b'), activeWorktreeId: WORKTREE_ID, createTab }
    registerTabLifecycleIpcBridge([])
    mocks.listeners.onNewTerminalTab()
    await vi.waitFor(() => expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalled())
    expect(mocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, environmentId: 'env-b' })
    )
    expect(createTab).not.toHaveBeenCalled()
  })

  it('refuses a local twin of a server: no host create and no local shell', async () => {
    const createTab = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.state = {
      ...ownerRows('local', 'runtime:env-b'),
      activeWorktreeId: WORKTREE_ID,
      createTab,
      setActiveTabType: vi.fn()
    }
    registerTabLifecycleIpcBridge([])
    mocks.listeners.onNewTerminalTab()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.createWebRuntimeSessionTerminal).not.toHaveBeenCalled()
    expect(createTab).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })
})
