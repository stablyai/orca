import { beforeEach, describe, expect, it, vi } from 'vitest'

const { closeWebRuntimeSessionTabMock, getStateMock } = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => false),
  isWebTerminalSurfaceTabId: vi.fn(() => false),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => null),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

import { activateTerminalTab, closeTerminalTab } from './terminal-tab-actions'

const WORKTREE_ID = 'repo-1::/Users/me/code/repo-1'

/**
 * The owner catalogs are present but hold no row for this worktree, and a saved runtime
 * environment blocks the legacy-local fallback — the state Orca is in during startup hydration,
 * after a failed `runtimeEnvironments.list()`, and while a repo's worktree scan is still pending.
 */
function unroutableOwnerState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [{ id: 'repo-1', connectionId: null, executionHostId: undefined }],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [{ id: 'env-1' }],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    unifiedTabsByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn(),
    setActiveWorktree: vi.fn(),
    setActiveFile: vi.fn(),
    setActiveBrowserTab: vi.fn(),
    ...overrides
  }
}

describe('closing a terminal tab whose worktree owner cannot be resolved', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('still prunes the tab instead of ignoring the close', () => {
    const closeTab = vi.fn()
    const onClosed = vi.fn()
    const onCancel = vi.fn()
    getStateMock.mockReturnValue(
      unroutableOwnerState({
        tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }, { id: 'tab-2' }] },
        activeWorktreeId: WORKTREE_ID,
        activeTabId: 'tab-1',
        closeTab
      })
    )

    closeTerminalTab('tab-1', { onClosed, onCancel })

    expect(closeTab).toHaveBeenCalledWith('tab-1')
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('skips the host-directed close, which is the only part the missing owner invalidates', () => {
    getStateMock.mockReturnValue(
      unroutableOwnerState({
        tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
        activeWorktreeId: WORKTREE_ID,
        activeTabId: 'tab-1',
        closeTab: vi.fn()
      })
    )

    closeTerminalTab('tab-1')

    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('keeps honoring the pinned-tab confirmation guard', () => {
    const closeTab = vi.fn()
    const onCancel = vi.fn()
    getStateMock.mockReturnValue(
      unroutableOwnerState({
        tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [
            { id: 'tab-1', entityId: 'tab-1', contentType: 'terminal', isPinned: true }
          ]
        },
        activeWorktreeId: WORKTREE_ID,
        activeTabId: 'tab-1',
        closeTab
      })
    )

    closeTerminalTab('tab-1', { rejectPinned: true, onCancel })

    expect(closeTab).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('still selects the tab on activation', () => {
    const setActiveTab = vi.fn()
    const setActiveTabType = vi.fn()
    getStateMock.mockReturnValue(
      unroutableOwnerState({
        tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
        setActiveTab,
        setActiveTabType
      })
    )

    activateTerminalTab('tab-1')

    expect(setActiveTab).toHaveBeenCalledWith('tab-1')
    expect(setActiveTabType).toHaveBeenCalledWith('terminal')
  })

  // Why: relaxing the route guard must not also relax the existence check. A tab in no worktree's
  // strip has nothing to select, and activating it would point the app at a tab that renders nothing.
  it('does not activate a tab that belongs to no worktree at all', () => {
    const setActiveTab = vi.fn()
    const setActiveTabType = vi.fn()
    getStateMock.mockReturnValue(
      unroutableOwnerState({
        tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] },
        setActiveTab,
        setActiveTabType
      })
    )

    activateTerminalTab('tab-vanished')

    expect(setActiveTab).not.toHaveBeenCalled()
    expect(setActiveTabType).not.toHaveBeenCalled()
  })
})
