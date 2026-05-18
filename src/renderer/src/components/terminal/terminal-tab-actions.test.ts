import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminalMock,
  getStateMock,
  isWebRuntimeSessionActiveMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  closeWebRuntimeSessionTabMock: vi.fn(),
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
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

import { createNewTerminalTab } from './terminal-tab-actions'

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

    expect(createTab).toHaveBeenCalledWith('wt-1', undefined, 'zsh')
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
      command: 'pwsh',
      activate: true
    })
    expect(createTab).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
  })
})
