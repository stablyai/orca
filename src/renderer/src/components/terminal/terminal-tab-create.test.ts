import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createBrowserUuidMock,
  createWebRuntimeSessionTerminalMock,
  getStateMock,
  isWebRuntimeSessionActiveMock
} = vi.hoisted(() => ({
  createBrowserUuidMock: vi.fn(() => 'tab-1'),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))
vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: createBrowserUuidMock
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

import { createNewTerminalTab } from './terminal-tab-create'
import { terminalOwnerRows } from './terminal-tab-owner-rows.test-fixture'

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
        ...terminalOwnerRows(null),
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

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, 'zsh', { id: 'tab-1' })
    expect(setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
    expect(setTabBarOrder).toHaveBeenCalledWith('wt-1', ['tab-1'])
    expect(createWebRuntimeSessionTerminalMock).not.toHaveBeenCalled()
  })

  it('keeps open browser tabs before the new terminal when no order is saved yet', () => {
    createBrowserUuidMock.mockReturnValueOnce('term-new')
    const setTabBarOrder = vi.fn()
    getStateMock
      .mockReturnValueOnce({
        ...terminalOwnerRows(null),
        createTab: vi.fn(() => ({ id: 'term-new' })),
        setActiveTabType: vi.fn(),
        setTabBarOrder
      })
      .mockReturnValueOnce({
        tabsByWorktree: { 'wt-1': [{ id: 'term-a' }, { id: 'term-new' }] },
        openFiles: [],
        browserTabsByWorktree: { 'wt-1': [{ id: 'browser-1' }] },
        tabBarOrderByWorktree: {},
        setTabBarOrder
      })

    createNewTerminalTab('wt-1')

    expect(setTabBarOrder).toHaveBeenCalledWith('wt-1', ['term-a', 'browser-1', 'term-new'])
  })

  it('delegates terminal creation to the host runtime in paired web clients', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      createTab,
      setActiveTabType
    })

    createNewTerminalTab('wt-1', 'pwsh')

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        shell: 'pwsh',
        activate: true
      },
      { userAct: true }
    )
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

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'owner-runtime',
        shell: 'pwsh',
        activate: true
      },
      { userAct: true }
    )
    expect(createTab).not.toHaveBeenCalled()
  })

  it('creates local terminal tabs with a requested startup cwd', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    const setActiveTabType = vi.fn()
    const setTabBarOrder = vi.fn()
    getStateMock
      .mockReturnValueOnce({
        ...terminalOwnerRows(null),
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
      id: 'tab-1',
      startupCwd: '/repo/packages/app'
    })
    expect(setActiveTabType).toHaveBeenCalledWith('terminal', 'wt-1')
  })

  it('delegates requested startup cwd to host runtime terminals', () => {
    const createTab = vi.fn(() => ({ id: 'tab-1' }))
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      createTab,
      setActiveTabType: vi.fn()
    })

    createNewTerminalTab('wt-1', undefined, { startupCwd: '/repo/packages/app' })

    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      {
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        command: undefined,
        cwd: '/repo/packages/app',
        activate: true
      },
      { userAct: true }
    )
    expect(createTab).not.toHaveBeenCalled()
  })

  it('reports a failed host launch to the caller instead of toasting it', async () => {
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    createWebRuntimeSessionTerminalMock.mockResolvedValue({ status: 'failed', message: 'offline' })
    getStateMock.mockReturnValue(terminalOwnerRows('web-runtime'))
    const onSettled = vi.fn()

    createNewTerminalTab('wt-1', undefined, { command: 'git fetch --unshallow origin', onSettled })

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
    expect(createWebRuntimeSessionTerminalMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'git fetch --unshallow origin' }),
      { userAct: true, notifyFailure: false }
    )
  })
})
