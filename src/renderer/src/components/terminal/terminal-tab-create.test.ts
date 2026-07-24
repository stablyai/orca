import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createWebRuntimeSessionTerminalMock, getStateMock, isWebRuntimeSessionActiveMock } =
  vi.hoisted(() => ({
    createWebRuntimeSessionTerminalMock: vi.fn(),
    getStateMock: vi.fn(),
    isWebRuntimeSessionActiveMock: vi.fn()
  }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

import { createNewTerminalTab } from './terminal-tab-create'

describe('createNewTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createWebRuntimeSessionTerminalMock.mockResolvedValue(true)
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('creates a local terminal tab outside the paired web runtime', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    const setTabBarOrder = vi.fn()
    getStateMock
      .mockReturnValueOnce({
        settings: { activeRuntimeEnvironmentId: null },
        createTab,
        setActiveTabType,
        setTabBarOrder
      })
      .mockReturnValueOnce({
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        openFiles: [],
        tabBarOrderByWorktree: {},
        setTabBarOrder
      })

    createNewTerminalTab('wt-1', 'zsh')

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, 'zsh', undefined)
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(setTabBarOrder).toHaveBeenCalledWith('wt-1', ['tab-1'])
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('delegates terminal creation to the host runtime in paired web clients', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
  })

  it('delegates terminal creation to the explicit owner runtime when another runtime is focused', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [{ id: 'repo-1', executionHostId: 'runtime:owner-runtime', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'owner-runtime',
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
  })

  it('creates local terminal tabs with a requested startup cwd', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    const setTabBarOrder = vi.fn()
    getStateMock
      .mockReturnValueOnce({
        settings: { activeRuntimeEnvironmentId: null },
        createTab,
        setActiveTabType,
        setTabBarOrder
      })
      .mockReturnValueOnce({
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        openFiles: [],
        tabBarOrderByWorktree: {},
        setTabBarOrder
      })

    createNewTerminalTab('wt-1', undefined, { startupCwd: '/repo/packages/app' })

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, undefined, {
      startupCwd: '/repo/packages/app'
    })
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  it('delegates requested startup cwd to host runtime terminals', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      createTab,
      setActiveTabType: vi.fn()
    })

    createNewTerminalTab('wt-1', undefined, { startupCwd: '/repo/packages/app' })

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'web-runtime',
      command: undefined,
      cwd: '/repo/packages/app',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
  })
})
