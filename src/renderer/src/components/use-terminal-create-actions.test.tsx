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
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
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
    useTerminalCreateActions({
      activeWorktreeId: WORKTREE_ID,
      createBrowserTab: mocks.createBrowserTab,
      createTab: vi.fn(),
      openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
      openNewMarkdownInActiveWorkspace: vi.fn(),
      openNewTerminalTabInActiveWorkspace: vi.fn(),
      setActiveTabType: vi.fn(),
      setTabBarOrder: vi.fn()
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

  it('toasts instead of creating a browser tab when the provider forbids it', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'no browser here' }
    renderActions().handleNewBrowserTab()
    expect(mocks.toastError).toHaveBeenCalledWith('no browser here')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('toasts instead of duplicating a browser tab when the provider forbids it', () => {
    mocks.browserAvailability = { state: 'hidden', reason: 'no browser here' }
    renderActions().handleDuplicateBrowserTab('browser-1')
    expect(mocks.toastError).toHaveBeenCalledWith('no browser here')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
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

  it('reports a rejected simulator open instead of leaving it unhandled', async () => {
    mocks.openMobileEmulatorTab.mockRejectedValue(new Error('emulator says no'))
    renderActions().handleNewSimulatorTab()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.toastError).toHaveBeenCalledWith('emulator says no')
  })
})
