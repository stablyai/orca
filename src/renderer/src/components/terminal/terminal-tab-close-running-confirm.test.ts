/**
 * Which `closeTerminalTab` callers reach the running-process confirmation (#10142).
 * Kept out of terminal-tab-actions.test.ts, which is already at its max-lines budget.
 */
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

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
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

import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import { closeTerminalTab } from './terminal-tab-actions'

const LEAF = '33333333-3333-4333-8333-333333333333'

const closeTab = vi.fn()

function busyTabState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: true },
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
    setActiveWorktree: vi.fn(),
    ...overrides
  }
}

function visibleRequest() {
  return useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm
}

async function settleProbe(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
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

  it('closes a busy tab only after the confirmation is accepted', async () => {
    closeTerminalTab('tab-busy')
    await settleProbe()

    expect(closeTab).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({
      terminalTabId: 'tab-busy',
      tabLabel: 'dev server',
      copyKind: 'command'
    })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(closeTab).toHaveBeenCalledWith('tab-busy')
  })

  it('keeps the tab and runs onCancel when the confirmation is dismissed', async () => {
    const onCancel = vi.fn()
    const onClosed = vi.fn()

    closeTerminalTab('tab-busy', { onCancel, onClosed })
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClosed).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('still reports the close through onClosed after the confirmation', async () => {
    const onClosed = vi.fn()

    closeTerminalTab('tab-busy', { onClosed })
    await settleProbe()
    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('stays fully synchronous for a tab with no live pty', () => {
    getStateMock.mockReturnValue(busyTabState({ ptyIdsByTabId: {}, terminalLayoutsByTabId: {} }))

    closeTerminalTab('tab-busy')

    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('tab-busy')
  })

  it.each([
    ['force (post-confirmation re-entry)', { force: true }],
    ['rejectPinned (CLI tab close request)', { rejectPinned: true }],
    ['skipRunningProcessConfirm (bulk / CLI)', { skipRunningProcessConfirm: true }],
    ['reason pty-exit', { reason: 'pty-exit' as const }],
    ['reason cleanup', { reason: 'cleanup' as const }],
    ['hostCloseReason pty-exit', { hostCloseReason: 'pty-exit' as const }],
    ['lifecyclePtyId', { lifecyclePtyId: 'pty-busy' }]
  ])('never probes for a close carrying %s', (_label, options) => {
    closeTerminalTab('tab-busy', options)

    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
  })

  it('shows only the pinned dialog for a pinned busy tab, and its confirm does not probe', () => {
    const state = busyTabState()
    ;(state.unifiedTabsByWorktree as Record<string, { isPinned: boolean }[]>)[
      'wt-1'
    ]![0]!.isPinned = true
    getStateMock.mockReturnValue(state)

    closeTerminalTab('tab-busy')

    expect(requestPinnedTabCloseConfirmMock).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()

    const onConfirm = requestPinnedTabCloseConfirmMock.mock.calls[0]![0].onConfirm as () => void
    onConfirm()

    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('tab-busy')
  })

  // Why: the pin prompt supersedes this one only when it actually appears. With the pin
  // confirmation off it says nothing, and the running command must still be announced.
  it('still asks about a running command on a pinned tab when pin confirmation is off', async () => {
    const state = busyTabState({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: false }
    })
    ;(state.unifiedTabsByWorktree as Record<string, { isPinned: boolean }[]>)[
      'wt-1'
    ]![0]!.isPinned = true
    getStateMock.mockReturnValue(state)

    closeTerminalTab('tab-busy')
    await settleProbe()

    expect(requestPinnedTabCloseConfirmMock).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
    expect(visibleRequest()).toMatchObject({ terminalTabId: 'tab-busy' })

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(closeTab).toHaveBeenCalledWith('tab-busy')
  })

  it('rejects a pinned tab for a CLI close even when pin confirmation is off', () => {
    const state = busyTabState({
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab: false }
    })
    ;(state.unifiedTabsByWorktree as Record<string, { isPinned: boolean }[]>)[
      'wt-1'
    ]![0]!.isPinned = true
    getStateMock.mockReturnValue(state)
    const onCancel = vi.fn()

    closeTerminalTab('tab-busy', { rejectPinned: true, onCancel })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(inspectRuntimeTerminalProcessMock).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('confirms before telling a paired host to close its busy tab', async () => {
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue(
      busyTabState({ settings: { activeRuntimeEnvironmentId: 'web-runtime' } })
    )

    closeTerminalTab('tab-busy')
    await settleProbe()

    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()

    useRunningTerminalCloseConfirmStore.getState().confirmRunningTerminalClose()

    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1)
  })

  it('picks the agent copy for a busy agent pane', async () => {
    getStateMock.mockReturnValue(
      busyTabState({ agentStatusByPaneKey: { [`tab-busy:${LEAF}`]: { agentType: 'claude' } } })
    )

    closeTerminalTab('tab-busy')
    await settleProbe()

    expect(visibleRequest()?.copyKind).toBe('agent')
  })
})
