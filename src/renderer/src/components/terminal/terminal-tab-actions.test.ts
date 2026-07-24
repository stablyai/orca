import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeWebRuntimeSessionTabMock,
  getLatestWebSessionTabsPublicationEpochMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  toHostSessionTabIdMock,
  archiveTerminalTabBeforeRetirementMock,
  canArchiveTerminalTabCloseMock,
  isTerminalArchiveTopologyCurrentMock,
  terminalArchiveCloseUnavailableErrorMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getLatestWebSessionTabsPublicationEpochMock: vi.fn(() => 'epoch-1'),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId),
  archiveTerminalTabBeforeRetirementMock: vi.fn(),
  canArchiveTerminalTabCloseMock: vi.fn(() => false),
  isTerminalArchiveTopologyCurrentMock: vi.fn(() => true),
  terminalArchiveCloseUnavailableErrorMock: vi.fn(
    () =>
      new Error('Terminal archive protection is unavailable. Keep this tab open and reload Orca.')
  )
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: getStateMock
  }
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabId: isWebTerminalSurfaceTabIdMock,
  toHostSessionTabId: toHostSessionTabIdMock
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: getLatestWebSessionTabsPublicationEpochMock,
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

vi.mock('./terminal-archive-close', () => ({
  archiveTerminalTabBeforeRetirement: archiveTerminalTabBeforeRetirementMock,
  canArchiveTerminalTabClose: canArchiveTerminalTabCloseMock,
  isTerminalArchiveTopologyCurrent: isTerminalArchiveTopologyCurrentMock,
  terminalArchiveCloseUnavailableError: terminalArchiveCloseUnavailableErrorMock
}))

import { closeTerminalTab } from './terminal-tab-actions'

describe('closeTerminalTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    isWebTerminalSurfaceTabIdMock.mockReturnValue(false)
    canArchiveTerminalTabCloseMock.mockReturnValue(false)
    isTerminalArchiveTopologyCurrentMock.mockReturnValue(true)
    closeWebRuntimeSessionTabMock.mockResolvedValue({
      closed: true,
      archiveId: '11111111-1111-4111-8111-111111111111'
    })
  })

  it('delegates host-backed terminal closes to the paired runtime after its archive receipt', async () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1')

    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith('local-tab-1', {
        reason: undefined,
        remoteCloseOwnedByHost: true
      })
    )
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime',
      reason: 'user'
    })
  })

  it('archives a user close before retirement and suppresses the duplicate recent-close snapshot', async () => {
    const closeTab = vi.fn()
    let resolveArchive: (receipt: {
      archiveId: string
      topologyFingerprint: string
    }) => void = () => {}
    canArchiveTerminalTabCloseMock.mockReturnValue(true)
    archiveTerminalTabBeforeRetirementMock.mockReturnValue(
      new Promise<{ archiveId: string; topologyFingerprint: string }>((resolve) => {
        resolveArchive = resolve
      })
    )
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo-1', executionHostId: 'local', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [
          { id: 'local-tab-1', ptyId: null },
          { id: 'local-tab-2', ptyId: null }
        ]
      },
      unifiedTabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      lastKnownRelayPtyIdByTabId: {},
      deferredSshSessionIdsByTabId: {},
      pendingReconnectPtyIdByTabId: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1')

    expect(archiveTerminalTabBeforeRetirementMock).toHaveBeenCalledWith('local-tab-1', 'wt-1')
    expect(closeTab).not.toHaveBeenCalled()
    resolveArchive({
      archiveId: '11111111-1111-4111-8111-111111111111',
      topologyFingerprint: 'stable'
    })
    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith(
        'local-tab-1',
        expect.objectContaining({ captureRecentlyClosed: false })
      )
    )
  })

  it('keeps the live tab when teardown fails after archiving', async () => {
    const closeTab = vi.fn()
    const onError = vi.fn()
    canArchiveTerminalTabCloseMock.mockReturnValue(true)
    archiveTerminalTabBeforeRetirementMock.mockResolvedValue({
      archiveId: '11111111-1111-4111-8111-111111111111',
      topologyFingerprint: 'stable'
    })
    vi.stubGlobal('window', {
      api: { pty: { kill: vi.fn().mockRejectedValue(new Error('SSH disconnected')) } }
    })
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      repos: [{ id: 'repo-1', executionHostId: 'local', connectionId: null }],
      worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
      tabsByWorktree: {
        'wt-1': [
          { id: 'local-tab-1', ptyId: 'local-pty-1' },
          { id: 'local-tab-2', ptyId: null }
        ]
      },
      unifiedTabsByWorktree: {},
      ptyIdsByTabId: { 'local-tab-1': ['local-pty-1'] },
      terminalLayoutsByTabId: {},
      lastKnownRelayPtyIdByTabId: {},
      deferredSshSessionIdsByTabId: {},
      pendingReconnectPtyIdByTabId: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', { onError })

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)))
    expect(closeTab).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('lets the HUB snapshot adjudicate a stream exit', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
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

  it('does not close a replacement PTY from a stale stream exit callback', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      ptyIdsByTabId: { 'local-tab-1': ['remote:web-runtime@@replacement-term'] },
      terminalLayoutsByTabId: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', {
      reason: 'pty-exit',
      lifecyclePtyId: 'remote:web-runtime@@retired-term'
    })

    expect(closeTab).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('sends hostCloseReason on the wire without tagging the local close reason', async () => {
    // Why: parked-tab lifecycle closes must reach the host as 'pty-exit' so it
    // can adjudicate them, while local guards keyed off `reason` still apply.
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
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

    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith('local-tab-1', {
        reason: undefined,
        remoteCloseOwnedByHost: true
      })
    )
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'web-runtime',
      reason: 'pty-exit',
      publicationEpoch: 'epoch-1',
      terminalHandle: 'term-1'
    })
  })

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

  it('marks a user action as explicit when no lifecycle reason is present', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1')

    const args = closeWebRuntimeSessionTabMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(args).toMatchObject({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      reason: 'user'
    })
  })

  it('does not convert a paired terminal exit into host close intent', () => {
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab-1')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'local-tab-1',
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('local-tab-1', { reason: 'pty-exit' })

    expect(closeTab).not.toHaveBeenCalled()
    expect(resolveHostSessionTabIdForWebSessionTabMock).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('closes unified-only terminal tabs for cleanup when tabsByWorktree is missing the row', () => {
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
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
      closeTab,
      closeUnifiedTab,
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1', { reason: 'cleanup' })

    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', { reason: 'cleanup' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('activates the next unified terminal tab when closing the active unified-only tab', () => {
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    const setActiveTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
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
          },
          {
            id: 'unified-tab-2',
            entityId: 'terminal-entity-2',
            contentType: 'terminal',
            groupId: 'group-1',
            worktreeId: 'wt-1',
            label: 'Terminal',
            customLabel: null,
            color: null,
            sortOrder: 1,
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
      closeTab,
      closeUnifiedTab,
      setActiveTab,
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('terminal-entity-1', { reason: 'cleanup' })

    expect(setActiveTab).toHaveBeenCalledWith('terminal-entity-2')
    expect(closeTab).toHaveBeenCalledWith('terminal-entity-1', { reason: 'cleanup' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('routes closes on a remote worktree to the host even when the local→host map has no entry', async () => {
    // Why: regression for the close-reappear bug. On a remote-owned worktree the
    // tab is host-authoritative; when the map has no entry (e.g. a plain-UUID host
    // tab id) the close must still reach the host via the decoded id, or the
    // host's next snapshot re-adds the tab. It also prunes locally for snappiness.
    const closeTab = vi.fn()
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'plain-uuid-tab' }, { id: 'local-tab-2' }]
      },
      activeWorktreeId: 'wt-1',
      activeTabId: 'plain-uuid-tab',
      openFiles: [],
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('plain-uuid-tab')

    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith('plain-uuid-tab', {
        reason: undefined,
        remoteCloseOwnedByHost: true
      })
    )
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
      closeTab: vi.fn(),
      closeUnifiedTab: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveWorktree: vi.fn(),
      requestPinnedTabCloseConfirm: vi.fn(),
      ...rest
    }
  }

  it('routes a pinned tab through the confirmation guard instead of closing it', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1')

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ tabLabel: 'Server', onConfirm: expect.any(Function) })
    )
  })

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

    closeTerminalTab('pinned-entity-1', { onClosed, reason: 'cleanup' })
    expect(onClosed).not.toHaveBeenCalled()
    const { onConfirm } = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onConfirm: () => void }
    onConfirm()

    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: 'cleanup' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('reports cancellation without finalizing a pinned tab close', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    const onClosed = vi.fn()
    const onCancel = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1', { onClosed, onCancel })
    const request = requestPinnedTabCloseConfirm.mock.calls[0][0] as { onCancel?: () => void }
    request.onCancel?.()

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('rejects a pinned background lifecycle close without opening a confirmation modal', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeUnifiedTab = vi.fn()
    const onClosed = vi.fn()
    const onCancel = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: true,
        requestPinnedTabCloseConfirm,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1', { rejectPinned: true, onClosed, onCancel })

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(1)
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

    // Why: TerminalPaneOverlayLayer closes by terminalTab.id (the unified id),
    // not the entityId. The guard must still recognize it as pinned.
    closeTerminalTab('unified-pinned-1')

    expect(closeUnifiedTab).not.toHaveBeenCalled()
    expect(requestPinnedTabCloseConfirm).toHaveBeenCalledTimes(1)
  })

  it('closes a pinned tab immediately when the confirmation setting is off', () => {
    const requestPinnedTabCloseConfirm = vi.fn()
    const closeTab = vi.fn()
    const closeUnifiedTab = vi.fn()
    getStateMock.mockReturnValue(
      makePinnedTabState({
        confirmClosePinnedTab: false,
        requestPinnedTabCloseConfirm,
        closeTab,
        closeUnifiedTab
      })
    )

    closeTerminalTab('pinned-entity-1', { reason: 'cleanup' })

    expect(requestPinnedTabCloseConfirm).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledWith('pinned-entity-1', { reason: 'cleanup' })
    expect(closeUnifiedTab).not.toHaveBeenCalled()
  })

  it('threads the PTY-exit reason through to closeTab', () => {
    const closeTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1' }, { id: 'tab-2' }]
      },
      unifiedTabsByWorktree: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab,
      setActiveTab: vi.fn()
    })

    // Why: the legacy no-layout surface routes pty exits through
    // closeTerminalTab; a self-exited shell must not join the reopen stack.
    closeTerminalTab('tab-1', { reason: 'pty-exit' })

    expect(closeTab).toHaveBeenCalledWith('tab-1', { reason: 'pty-exit' })
  })

  it('threads parked-exit history suppression through to closeTab', () => {
    const closeTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }, { id: 'tab-2' }] },
      unifiedTabsByWorktree: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab,
      setActiveTab: vi.fn()
    })

    closeTerminalTab('tab-1', { reason: 'pty-exit', captureRecentlyClosed: false })

    expect(closeTab).toHaveBeenCalledWith('tab-1', {
      reason: 'pty-exit',
      captureRecentlyClosed: false
    })
  })

  it('keeps a user tab live when archive capability is unavailable', () => {
    const closeTab = vi.fn()
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: {
        'wt-1': [{ id: 'tab-1' }, { id: 'tab-2' }]
      },
      unifiedTabsByWorktree: {},
      activeWorktreeId: 'wt-1',
      activeTabId: 'tab-2',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab,
      setActiveTab: vi.fn()
    })

    const onError = vi.fn()
    closeTerminalTab('tab-1', { onError })

    expect(closeTab).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
