// A pinned terminal tab of a server workspace: only the confirmed close asks the server to force it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeWebRuntimeSessionTab: vi.fn(),
  getState: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => true)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))
vi.mock('@/runtime/web-session-tabs-sync/tracking-lifecycle', () => ({
  getLatestWebSessionTabsPublicationEpoch: () => 'epoch-1'
}))
vi.mock('@/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: () => 'host-tab-1'
}))

import { closeTerminalTab } from './terminal-tab-actions'
import { terminalOwnerRows } from './terminal-tab-owner-rows.test-fixture'

function serverWorkspaceState(isPinned: boolean, confirmClosePinnedTab = true) {
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab },
    ...terminalOwnerRows('server-env'),
    tabsByWorktree: { 'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }] },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'unified-1',
          entityId: 'local-tab-1',
          contentType: 'terminal',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          label: 'Server',
          isPinned
        }
      ]
    },
    activeWorktreeId: 'wt-1',
    activeTabId: 'local-tab-1',
    closeTab: vi.fn(),
    closeUnifiedTab: vi.fn(),
    setActiveTab: vi.fn(),
    requestPinnedTabCloseConfirm:
      vi.fn<(request: { onConfirm: () => void; onCancel?: () => void }) => void>()
  }
}

describe('closing a pinned terminal tab of a server workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the server to force the close once the user confirms', () => {
    const state = serverWorkspaceState(true)
    mocks.getState.mockReturnValue(state)

    closeTerminalTab('local-tab-1')
    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
    const { onConfirm } = state.requestPinnedTabCloseConfirm.mock.calls[0][0]
    onConfirm()

    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'server-env',
      reason: 'user',
      force: true
    })
  })

  it('sends nothing when the user cancels the confirmation', () => {
    const state = serverWorkspaceState(true)
    mocks.getState.mockReturnValue(state)

    closeTerminalTab('local-tab-1')
    const request = state.requestPinnedTabCloseConfirm.mock.calls[0][0]
    request.onCancel?.()

    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })

  it('forces a pinned close when the pin confirmation is turned off', () => {
    mocks.getState.mockReturnValue(serverWorkspaceState(true, false))
    closeTerminalTab('local-tab-1')

    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'host-tab-1', reason: 'user', force: true })
    )
  })

  it('never forces the close of an unpinned tab', () => {
    mocks.getState.mockReturnValue(serverWorkspaceState(false))
    closeTerminalTab('local-tab-1')

    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeWebRuntimeSessionTab.mock.calls[0][0]).not.toHaveProperty('force')
  })

  it('rejects a pinned lifecycle close without forcing, even with the confirmation off', () => {
    const onCancel = vi.fn()
    mocks.getState.mockReturnValue(serverWorkspaceState(true, false))
    closeTerminalTab('local-tab-1', { rejectPinned: true, onCancel })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(mocks.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })

  it("sends the close of another runtime's terminal in this workspace to that runtime", () => {
    const state = serverWorkspaceState(false)
    mocks.getState.mockReturnValue({
      ...state,
      tabsByWorktree: { 'wt-1': [{ id: 'local-tab-1', ptyId: 'remote:desktop-env@@term-9' }] }
    })
    closeTerminalTab('local-tab-1')

    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'host-tab-1', environmentId: 'desktop-env' })
    )
  })

  it('never forces a pinned lifecycle close, even with the confirmation off', () => {
    mocks.getState.mockReturnValue(serverWorkspaceState(true, false))
    closeTerminalTab('local-tab-1', {
      hostCloseReason: 'pty-exit',
      lifecyclePtyId: 'remote:server-env@@term-1'
    })

    expect(mocks.closeWebRuntimeSessionTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeWebRuntimeSessionTab.mock.calls[0][0]).toMatchObject({ reason: 'pty-exit' })
    expect(mocks.closeWebRuntimeSessionTab.mock.calls[0][0]).not.toHaveProperty('force')
  })
})
