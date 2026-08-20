import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  getRuntimeEnvironmentIdForWorktreeMock,
  isWebRuntimeSessionActiveMock,
  focusTerminalTabSurfaceMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  getRuntimeEnvironmentIdForWorktreeMock: vi.fn(() => 'env-1'),
  isWebRuntimeSessionActiveMock: vi.fn(() => true),
  focusTerminalTabSurfaceMock: vi.fn()
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: getRuntimeEnvironmentIdForWorktreeMock
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: focusTerminalTabSurfaceMock
}))

import { activateUnifiedTab } from './unified-tab-activation'

function browserTab() {
  return {
    id: 'unified-browser',
    entityId: 'browser-1',
    contentType: 'browser' as const,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    label: 'browser',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function storeWith(overrides: Record<string, unknown>) {
  return {
    focusGroup: vi.fn(),
    activateTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveTabType: vi.fn(),
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {},
    ...overrides
  }
}

describe('activateUnifiedTab browser branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
  })

  it('activates the host session tab when the workspace has a remote owner', () => {
    const store = storeWith({
      browserPagesByWorkspace: {
        'browser-1': [{ id: 'page-1', browserRuntimeEnvironmentId: 'env-1' }]
      },
      remoteBrowserPageHandlesByPageId: {}
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activateUnifiedTab(store as any, browserTab())

    expect(activateWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1)
    // The browser branch sends the tab id, not the entity id the terminal branch sends.
    expect(activateWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'unified-browser',
      environmentId: 'env-1'
    })
    expect(store.setActiveBrowserTab).toHaveBeenCalledWith('browser-1')
  })

  it('does not activate a host session tab for a local browser tab in a runtime worktree', () => {
    const store = storeWith({
      browserPagesByWorkspace: {
        'browser-1': [{ id: 'page-1', browserRuntimeEnvironmentId: null }]
      },
      remoteBrowserPageHandlesByPageId: {}
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    activateUnifiedTab(store as any, browserTab())

    expect(activateWebRuntimeSessionTabMock).not.toHaveBeenCalled()
    expect(store.setActiveBrowserTab).toHaveBeenCalledWith('browser-1')
    expect(store.setActiveTabType).toHaveBeenCalledWith('browser')
  })
})
