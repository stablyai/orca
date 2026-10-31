// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientCreationActionAvailability } from '@/lib/client-creation-action-policy'
import { useTerminalCreateActions } from './use-terminal-create-actions'
import type { TerminalColdActivationController } from './terminal-cold-activation'

const mocks = vi.hoisted(() => ({
  browserAvailability: {
    state: 'enabled',
    provider: 'local-client'
  } as ClientCreationActionAvailability,
  simulatorAvailability: {
    state: 'enabled',
    provider: 'local-client'
  } as ClientCreationActionAvailability,
  state: {} as Record<string, unknown>,
  toastError: vi.fn(),
  createBrowserTab: vi.fn(),
  createTab: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openMobileEmulatorTab: vi.fn()
}))

vi.mock('../store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args), message: vi.fn() }
}))
vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({
    'managed-browser': mocks.browserAvailability,
    'mobile-emulator': mocks.simulatorAvailability
  })
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn()
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => false
}))
vi.mock('@/lib/open-mobile-emulator-tab', () => ({
  openMobileEmulatorTab: (...args: unknown[]) => mocks.openMobileEmulatorTab(...args)
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: vi.fn() }))
vi.mock('@/lib/duplicate-browser-tab-options', () => ({
  buildDuplicatedBrowserTabOptions: () => ({})
}))
vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => false
}))
vi.mock('./tab-bar/tab-create-entry-action', () => ({ openTabBarEntry: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./terminal-workspace-model', () => ({
  getActiveWorktreeRuntimeEnvironmentId: () => null
}))

const WORKTREE_ID = 'repo-1::/repo/worktree'

function renderActions() {
  return renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these controller fields.
    useTerminalCreateActions({
      activeWorktreeId: WORKTREE_ID,
      createBrowserTab: mocks.createBrowserTab,
      createTab: mocks.createTab,
      openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace: vi.fn(),
      openNewTerminalTabInActiveWorkspace: vi.fn(),
      setActiveTabType: vi.fn()
    } as unknown as TerminalColdActivationController)
  ).result.current
}

describe('useTerminalCreateActions creation gates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
    mocks.simulatorAvailability = { state: 'enabled', provider: 'local-client' }
    mocks.state = {
      activeGroupIdByWorktree: {},
      groupsByWorktree: {},
      browserDefaultUrl: 'about:blank',
      browserTabsByWorktree: { [WORKTREE_ID]: [{ id: 'browser-1', url: 'https://example.com' }] }
    }
  })

  it('reports a rejected workspace browser open instead of leaving it unhandled', async () => {
    mocks.state.activeGroupIdByWorktree = { [WORKTREE_ID]: 'group-1' }
    mocks.openNewBrowserTabInActiveWorkspace.mockRejectedValue(new Error('runtime says no'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    renderActions().handleNewBrowserTab()
    await new Promise((resolve) => setTimeout(resolve, 0))
    process.off('unhandledRejection', unhandled)
    expect(mocks.toastError).toHaveBeenCalledWith('runtime says no')
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('appends a shell-override terminal to the saved order, dropping repeated ids', () => {
    const setTabBarOrder = vi.fn()
    const terminals = [{ id: 'term-a' }]
    mocks.state = {
      ...mocks.state,
      tabsByWorktree: { [WORKTREE_ID]: terminals },
      openFiles: [],
      tabBarOrderByWorktree: { [WORKTREE_ID]: ['browser-1', 'term-a', 'browser-1'] },
      setTabBarOrder
    }
    mocks.createTab.mockImplementation(
      (_worktreeId: string, _groupId: undefined, _shell: string, options: { id: string }) => {
        terminals.push({ id: options.id })
      }
    )
    renderActions().handleNewTab('/bin/zsh')
    expect(mocks.createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, '/bin/zsh', {
      id: expect.any(String)
    })
    const tabId = mocks.createTab.mock.calls[0][3].id
    expect(setTabBarOrder).toHaveBeenCalledWith(WORKTREE_ID, ['browser-1', 'term-a', tabId])
  })
})
