/**
 * Regression for #10142: the tab X button / middle-click used to bypass the
 * running-process close confirmation that Cmd+W enforces. Assertions unchanged
 * from the adjudicated repro.
 *
 * Mouse close path: SortableTab (X onClick / onAuxClick button===1) -> onClose
 *   -> Terminal.tsx handleCloseTab -> closeTerminalTab() -> running-process guard.
 * Keyboard path: Cmd+W -> TerminalPane.handleRequestClosePane -> probePtyRunningWork
 *   (split panes) or closeTerminalTab's guard (last pane) -> CloseTerminalDialog.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requestPinnedTabCloseConfirmMock,
  getStateMock,
  inspectRuntimeTerminalProcessMock,
  isWebRuntimeSessionActiveMock,
  resolveHostSessionTabIdForWebSessionTabMock
} = vi.hoisted(() => ({
  requestPinnedTabCloseConfirmMock: vi.fn(),
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { closeTerminalTab } from './terminal-tab-actions'

// A non-pinned terminal tab whose PTY has a live child process (e.g. `sleep 300`).
function stateWithBusyTerminalTab(closeTab: () => void): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
    tabsByWorktree: { 'wt-1': [{ id: 'tab-busy' }, { id: 'tab-other' }] },
    unifiedTabsByWorktree: {
      'wt-1': [
        { id: 'tab-busy', entityId: 'tab-busy', contentType: 'terminal', isPinned: false },
        { id: 'tab-other', entityId: 'tab-other', contentType: 'terminal', isPinned: false }
      ]
    },
    ptyIdsByTabId: { 'tab-busy': ['pty-busy'] },
    terminalLayoutsByTabId: { 'tab-busy': { ptyIdsByLeafId: { leaf: 'pty-busy' } } },
    agentStatusByPaneKey: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-busy',
    closeTab,
    requestPinnedTabCloseConfirm: requestPinnedTabCloseConfirmMock,
    setActiveTab: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    setActiveWorktree: vi.fn()
  }
}

describe('#10142 close confirmation policy is the same for keyboard and mouse', () => {
  const closeTab = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    getStateMock.mockReturnValue(stateWithBusyTerminalTab(closeTab))
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'sleep',
      hasChildProcesses: true
    })
  })

  it('hides a revealed room terminal without closing its busy session', () => {
    const notifyTerminalSurfaceClosed = vi.fn()
    vi.stubGlobal('window', {
      api: { ui: { notifyTerminalSurfaceClosed } }
    })
    getStateMock.mockReturnValue({
      ...stateWithBusyTerminalTab(closeTab),
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-busy', preserveSessionOnClose: true }, { id: 'tab-other' }]
      }
    })

    try {
      closeTerminalTab('tab-busy')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(closeTab).toHaveBeenCalledWith('tab-busy', { preserveSessionOnClose: true })
    expect(notifyTerminalSurfaceClosed).toHaveBeenCalledWith('tab-busy')
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })
  // Control: the harness does observe a guard when one exists — pinning blocks the same mouse close.
  it('mouse close routes a pinned tab through its confirmation guard', () => {
    const state = stateWithBusyTerminalTab(closeTab)
    ;(state.unifiedTabsByWorktree as Record<string, { isPinned: boolean }[]>)[
      'wt-1'
    ]![0]!.isPinned = true
    getStateMock.mockReturnValue(state)

    closeTerminalTab('tab-busy')

    expect(requestPinnedTabCloseConfirmMock).toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('mouse close (X button / middle-click) does not drop a busy tab without confirmation', async () => {
    closeTerminalTab('tab-busy')
    await Promise.resolve()

    expect(closeTab).not.toHaveBeenCalled()
  })
})
