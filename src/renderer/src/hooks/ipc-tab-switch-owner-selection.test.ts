import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  navOrder: vi.fn(),
  activateOnOwner: vi.fn(async (_args: Record<string, unknown>) => true),
  ownerEnvironmentId: vi.fn((): string | null => 'env-1'),
  runtimeRpc: vi.fn(async () => ({}))
}))

vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/components/tab-bar/group-tab-order', () => ({ getActiveTabNavOrder: mocks.navOrder }))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: mocks.activateOnOwner
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: (environmentId: string | null) =>
    environmentId === 'env-1' || environmentId === 'env-2'
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => mocks.ownerEnvironmentId()
}))
vi.mock('@/runtime/remote-browser-tab-ownership', () => ({
  browserWorkspaceHasRemoteOwner: () => true
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.runtimeRpc }))

import {
  handleSwitchRecentTab,
  handleSwitchTabAcrossAllTypes,
  handleSwitchTerminalTab
} from './ipc-tab-switch'

const WT = 'repo::/srv/app'

function agentTab(executionHostId: string) {
  return {
    id: 'agent-tab',
    entityId: 'session-1',
    worktreeId: WT,
    contentType: 'agent-session',
    executionHostId
  }
}

function serverWorkspaceStore(unifiedTabs: unknown[] = []) {
  return {
    activeWorktreeId: WT,
    activeTabType: 'terminal',
    activeTabId: 'web-terminal-b',
    activeFileId: null,
    activeBrowserTabId: null,
    activeGroupIdByWorktree: { [WT]: 'g' },
    groupsByWorktree: {
      [WT]: [
        {
          id: 'g',
          activeTabId: 'web-terminal-b',
          tabOrder: ['web-terminal-a', 'web-terminal-b'],
          recentTabIds: ['web-terminal-a', 'web-terminal-b']
        }
      ]
    },
    tabsByWorktree: { [WT]: [{ id: 'web-terminal-a' }, { id: 'web-terminal-b' }] },
    unifiedTabsByWorktree: { [WT]: unifiedTabs },
    terminalLayoutsByTabId: { 'web-terminal-a': { activeLeafId: 'leaf-a' } },
    setActiveTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    activateTab: vi.fn(),
    setActiveTabType: vi.fn(),
    getActiveTab: () => null
  }
}

// A server workspace reopens on the selection the server holds for this desktop, so every keyboard switch must update it.
describe('keyboard tab switches in a server workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ownerEnvironmentId.mockReturnValue('env-1')
    mocks.navOrder.mockReturnValue([
      { type: 'terminal', id: 'web-terminal-a', tabId: 'web-terminal-a' },
      { type: 'terminal', id: 'web-terminal-b', tabId: 'web-terminal-b' }
    ])
  })

  it.each([
    ['previous tab', () => handleSwitchTabAcrossAllTypes(-1)],
    ['previous terminal', () => handleSwitchTerminalTab(-1)],
    ['recent tab', () => handleSwitchRecentTab()]
  ])('tells the server about a %s switch', (_name, run) => {
    mocks.getState.mockReturnValue(serverWorkspaceStore())
    expect(run()).toBe(true)
    expect(mocks.activateOnOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: WT,
        tabId: 'web-terminal-a',
        environmentId: 'env-1',
        leafId: 'leaf-a'
      })
    )
  })

  it('stays local for a workspace no server owns', () => {
    mocks.ownerEnvironmentId.mockReturnValue(null)
    mocks.getState.mockReturnValue(serverWorkspaceStore())
    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(mocks.activateOnOwner).not.toHaveBeenCalled()
  })

  it('tells the server about a browser tab it hosts, cancelable by later navigation', () => {
    mocks.getState.mockReturnValue(serverWorkspaceStore())
    mocks.navOrder.mockReturnValue([
      { type: 'browser', id: 'browser-ws', tabId: 'browser-tab' },
      { type: 'terminal', id: 'web-terminal-b', tabId: 'web-terminal-b' }
    ])
    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(mocks.activateOnOwner).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'browser-tab', environmentId: 'env-1' })
    )
    expect(mocks.activateOnOwner.mock.calls[0]?.[0]).toHaveProperty('expectedCurrentLocalTabId')
  })

  it.each([
    ['the workspace server', 'runtime:env-1', 'env-1'],
    ['another server whose chat this workspace shows', 'runtime:env-2', 'env-2']
  ])('tells %s about an agent chat switch', (_name, executionHostId, environmentId) => {
    mocks.getState.mockReturnValue(serverWorkspaceStore([agentTab(executionHostId)]))
    mocks.navOrder.mockReturnValue([
      { type: 'agent-session', id: 'session-1', tabId: 'agent-tab' },
      { type: 'terminal', id: 'web-terminal-b', tabId: 'web-terminal-b' }
    ])
    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(mocks.runtimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId },
      'session.tabs.activate',
      expect.objectContaining({
        tabId: 'agent-session:session-1',
        notifyClients: false,
        navigation: 'caller'
      })
    )
  })

  it('keeps a switch to a chat this machine hosts local', () => {
    mocks.getState.mockReturnValue(serverWorkspaceStore([agentTab('local')]))
    mocks.navOrder.mockReturnValue([
      { type: 'agent-session', id: 'session-1', tabId: 'agent-tab' },
      { type: 'terminal', id: 'web-terminal-b', tabId: 'web-terminal-b' }
    ])
    expect(handleSwitchTabAcrossAllTypes(-1)).toBe(true)
    expect(mocks.runtimeRpc).not.toHaveBeenCalled()
  })
})
