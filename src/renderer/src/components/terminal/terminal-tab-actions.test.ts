import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateWebRuntimeSessionTabMock,
  createBrowserUuidMock,
  closeWebRuntimeSessionTabMock,
  createWebRuntimeSessionTerminalMock,
  getLatestWebSessionTabsPublicationEpochMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  activateWebRuntimeSessionTabMock: vi.fn(),
  createBrowserUuidMock: vi.fn(() => 'tab-1'),
  closeWebRuntimeSessionTabMock: vi.fn(),
  createWebRuntimeSessionTerminalMock: vi.fn(),
  getLatestWebSessionTabsPublicationEpochMock: vi.fn(() => 'epoch-1'),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('../../../../shared/non-secure-context-uuid', () => ({
  createNonSecureContextUuid: createBrowserUuidMock
}))

vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: activateWebRuntimeSessionTabMock,
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: createWebRuntimeSessionTerminalMock
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock
}))
vi.mock('../../../../shared/workspace-layout/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: isWebTerminalSurfaceTabIdMock,
  toHostSessionTabId: toHostSessionTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync/tracking-lifecycle', () => ({
  getLatestWebSessionTabsPublicationEpoch: getLatestWebSessionTabsPublicationEpochMock
}))
vi.mock('@/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { closeOtherTerminalTabs, closeTerminalTab } from './terminal-tab-actions'
import { terminalOwnerRows } from './terminal-tab-owner-rows.test-fixture'

describe('closeTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    isWebTerminalSurfaceTabIdMock.mockReturnValue(false)
  })

  it('delegates host-backed terminal closes to the paired runtime', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', { reason: 'user' })

    expect(closeTab).toHaveBeenCalledWith('local-tab-1', {
      reason: 'user',
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime',
      reason: 'user'
    })
  })

  it('lets the HUB snapshot adjudicate a stream exit', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', {
      reason: 'pty-exit',
      lifecyclePtyId: 'remote:web-runtime@@term-1'
    })

    expect(closeTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('sends hostCloseReason on the wire without tagging the local close reason', () => {
    // Lifecycle close reason must reach host adjudication while local guards still use the original reason.
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', {
      hostCloseReason: 'pty-exit',
      lifecyclePtyId: 'remote:web-runtime@@term-1'
    })

    expect(closeTab).toHaveBeenCalledWith('local-tab-1', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime',
      reason: 'pty-exit',
      publicationEpoch: 'epoch-1',
      terminalHandle: 'term-1'
    })
  })

  it.each([
    ['user', 'user'],
    ['requested', 'user'],
    ['cleanup', 'cleanup']
  ] as const)(
    'sends a %s close to a paired host as %s, so only declared intent is destructive (#37245)',
    (reason, wireReason) => {
      isWebRuntimeSessionActiveMock.mockReturnValue(true)
      resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
      getStateMock.mockReturnValue({
        ...terminalOwnerRows('web-runtime'),
        tabsByWorktree: { 'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }] },
        activeWorktreeId: 'wt-1',
        activeTabId: 'local-tab-1',
        closeTab: vi.fn(),
        setActiveTab: vi.fn()
      })

      closeTerminalTab('local-tab-1', { reason, skipRunningProcessConfirm: true })

      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 'host-tab-1', reason: wireReason })
      )
    }
  )

  it('keeps the pinned confirmation guard for a hostCloseReason pty-exit close', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1', { hostCloseReason: 'pty-exit' })

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })

  it('closes unified-only terminal tabs when tabsByWorktree is missing the row', () => {
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue({
      ...terminalOwnerRows(null),
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-tab-1',
            entityId: 'terminal-entity-1',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Claude',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            isPreview: false,
            isPinned: false
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'terminal-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
      closeTab,
      closeUnifiedTab,
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1', { reason: 'user' })

    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', { reason: 'user' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes closes on a remote worktree to the host even when the local→host map has no entry', () => {
    // Decode unmapped plain-UUID host tabs too, or the next authoritative snapshot resurrects a locally closed tab.
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      tabsByWorktree: {
        'wt-1': [{ id: 'plain-uuid-tab' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'plain-uuid-tab',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('plain-uuid-tab', { reason: 'user' })

    expect(closeTab).toHaveBeenCalledWith('plain-uuid-tab', {
      reason: 'user',
      remoteCloseOwnedByHost: true
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'plain-uuid-tab',
      environmentId: 'web-runtime',
      reason: 'user'
    })
  })

  function makePinnedTabState(
    overrides: { confirmClosePinnedTab: boolean } & Record<string, unknown>
  ): Record<string, unknown> {
    const { confirmClosePinnedTab, ...rest } = overrides
    return {
      settings: { activeRuntimeEnvironmentId: null, confirmClosePinnedTab },
      ...terminalOwnerRows(null),
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
            isPinned: true
          }
        ]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'pinned-entity-1',
      openFiles: [],
      browserTabsByWorktree: {},
      reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
      closeTab: vi.fn(),
      closeUnifiedTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn(),
      requestPinnedTabCloseConfirm: vi.fn(),
      ...rest
    }
  }

  it('closes the pinned tab when the confirmation callback runs', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    const onClosed = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeTab,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1', { reason: 'user', onClosed })
    expect(onClosed).not.toHaveBeenCalled()
    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: 'user' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('guards a pinned tab closed by its unified id (workspace overlay path)', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    // Overlay close supplies the unified ID, so pin detection must recognize it.
    closeTerminalTab('unified-pinned-1', { reason: 'user' })

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('closeOtherTerminalTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates other terminal closes to the host runtime in paired web clients', () => {
    const setActiveTab = vi.fn()
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      ...terminalOwnerRows('web-runtime'),
      tabsByWorktree: {
        'wt-1': [{ id: 'keep' }, { id: 'close-a' }, { id: 'close-b' }]
      },
      setActiveTab,
      closeTab
    })

    closeOtherTerminalTabs('keep', 'wt-1')

    expect(setActiveTab).toHaveBeenCalledWith('keep')
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2)
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-a',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-b',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeTab).toHaveBeenCalledTimes(2)
    expect(closeTab).toHaveBeenNthCalledWith(1, 'close-a', { remoteCloseOwnedByHost: true })
    expect(closeTab).toHaveBeenNthCalledWith(2, 'close-b', { remoteCloseOwnedByHost: true })
  })
})
