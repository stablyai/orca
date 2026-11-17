import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
/** Verify which closeTerminalTab callers reach running-process confirmation (#10142). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeWebRuntimeSessionTabMock,
  getStateMock,
  inspectRuntimeTerminalProcessMock,
  isWebRuntimeSessionActiveMock,
  requestPinnedTabCloseConfirmMock,
  resolveHostSessionTabIdForWebSessionTabMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn(),
  inspectRuntimeTerminalProcessMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(() => false),
  requestPinnedTabCloseConfirmMock: vi.fn(),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null)
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: getStateMock }
}))

vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock
}))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: vi.fn()
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))
vi.mock('../../../../../shared/workspace-layout/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync/tracking/tracking-lifecycle', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1')
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: inspectRuntimeTerminalProcessMock
}))

import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import { closeTerminalTab } from './terminal-tab-actions'
import { terminalOwnerRows } from './terminal-tab-owner-rows.test-fixture'

const LEAF = '33333333-3333-4333-8333-333333333333'

const closeTab = vi.fn()

function busyTabState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
    ...terminalOwnerRows(null),
    tabsByWorktree: { 'wt-1': [{ id: 'tab-busy' }, { id: 'tab-other' }] },
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-busy',
          entityId: 'tab-busy',
          contentType: 'terminal',
          isPinned: false,
          label: 'dev server'
        },
        { id: 'tab-other', entityId: 'tab-other', contentType: 'terminal', isPinned: false }
      ]
    },
    ptyIdsByTabId: { 'tab-busy': ['pty-busy'] },
    terminalLayoutsByTabId: { 'tab-busy': { ptyIdsByLeafId: { [LEAF]: 'pty-busy' } } },
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
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
    setActiveWorktree: vi.fn(),
    ...overrides
  }
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

// Flush generously across inspect, batch-join, and deadline await boundaries.
async function settleProbe(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve()
  }
}

describe('closeTerminalTab running-process confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStateMock.mockReturnValue(busyTabState())
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    inspectRuntimeTerminalProcessMock.mockResolvedValue({
      foregroundProcess: 'npm',
      hasChildProcesses: true
    })
  })

  afterEach(() => {
    const store = useRunningTerminalCloseConfirmStore.getState()
    while (visibleRequest()) {
      store.dismissRunningTerminalClose()
    }
  })

  // Only an actual pin prompt supersedes process confirmation; disabling pin confirmation still requires the busy-command prompt.
  it('still asks about a running command on a pinned tab when pin confirmation is off', async () => {
    const state = busyTabState({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: false },
      ...terminalOwnerRows(null)
    })
    ;(state.unifiedTabsByWorktree as Record<string, { isPinned: boolean }[]>)[
      'wt-1'
    ]![0]!.isPinned = true
    getStateMock.mockReturnValue(state)

    closeTerminalTab('tab-busy', { reason: 'user' })
    await settleProbe()

    expect(requestPinnedTabCloseConfirmMock).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-busy' })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(closeTab).toHaveBeenCalledWith('tab-busy', { reason: 'user' })
  })
})
