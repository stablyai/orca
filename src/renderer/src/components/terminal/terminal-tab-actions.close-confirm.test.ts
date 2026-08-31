import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: vi.fn<() => string | null>(() => null)
}))

import { closeTerminalTab } from './terminal-tab-actions'

function makePinnedTabState(
  overrides: { confirmClosePinnedTab: boolean; confirmCloseAnyTab?: boolean; isPinned?: boolean } & Record<
    string,
    unknown
  >
): Record<string, unknown> {
  const { confirmClosePinnedTab, confirmCloseAnyTab = false, isPinned = true, ...rest } = overrides
  return {
    settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab, confirmCloseAnyTab },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'unified-pinned-1',
          entityId: 'pinned-entity-1',
          contentType: 'terminal',
          groupId: 'group-1',
          worktreeId: 'wt-1',
          label: 'Server',
          generatedLabel: null,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0,
          isPreview: false,
          isPinned
        }
      ]
    },
    activeWorktreeId: 'wt-1',
    activeTabId: 'pinned-entity-1',
    openFiles: [],
    browserTabsByWorktree: {},
    closeTab: vi.fn(),
    closeUnifiedTab: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveWorktree: vi.fn(),
    // Why: main's close path lands an emptied worktree via reconcileWorktreeTabModel;
    // these tests assert confirm gating, not landing, so report a non-empty count.
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 1 })),
    requestPinnedTabCloseConfirm: vi.fn(),
    ...rest
  }
}

describe('closeTerminalTab confirm-close', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes an unpinned terminal through the guard when confirmCloseAnyTab is on and userInitiated', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        confirmCloseAnyTab: true,
        isPinned: false,
        requestPinnedTabCloseConfirm,
        closeTab
      })
    )

    closeTerminalTab('pinned-entity-1', { userInitiated: true })

    expect(closeTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        tabLabel: 'Server',
        variant: 'any',
        onConfirm: expect.any(Function)
      })
    )

    // Why: assert the continuation actually closes the tab, not just that a
    // dialog was requested — a broken onConfirm would otherwise pass silently.
    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0]
    onConfirm()
    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: undefined })
  })

  it('does not prompt for confirmCloseAnyTab when the close is not user-initiated', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        confirmCloseAnyTab: true,
        isPinned: false,
        requestPinnedTabCloseConfirm,
        closeTab
      })
    )

    // Why: autonomous/bulk closes (e.g. a parked tab's PTY exit) omit userInitiated
    // and must never open the confirm-any dialog for a tab the user isn't closing.
    closeTerminalTab('pinned-entity-1')

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: undefined })
  })

  it('still prompts for a pinned tab even when the close is not user-initiated', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        confirmCloseAnyTab: false,
        isPinned: true,
        requestPinnedTabCloseConfirm,
        closeTab
      })
    )

    // Why: a non-user-initiated, non-PTY-exit close of a pinned tab (e.g. a
    // bulk/programmatic close) must still keep the pinned confirmation.
    closeTerminalTab('pinned-entity-1')

    expect(closeTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm.mock.calls[0][0]).toMatchObject({ variant: 'pinned' })
  })
})
