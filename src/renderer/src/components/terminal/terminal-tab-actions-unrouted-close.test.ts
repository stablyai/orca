import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

const { closeWebRuntimeSessionTabMock, getStateMock, isWebRuntimeSessionActiveMock } = vi.hoisted(
  () => ({
    closeWebRuntimeSessionTabMock: vi.fn(),
    getStateMock: vi.fn(),
    isWebRuntimeSessionActiveMock: vi.fn()
  })
)

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  toHostSessionTabId: (tabId: string) => tabId
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: () => null,
  resolveHostSessionTabIdForWebSessionTab: () => null
}))

import { closeTerminalTab } from './terminal-tab-actions'

const WORKTREE_ID = 'repo-1::/srv/app'

/** The worktree catalog has not hydrated yet, so the worktree itself names no host (#11308). */
function unhydratedState(ptyId: string | null, closeTab = vi.fn()) {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1', ptyId, worktreeId: WORKTREE_ID }] },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    activeWorktreeId: null,
    activeTabId: null,
    openFiles: [],
    closeTab,
    setActiveTab: vi.fn()
  }
}

describe('closeTerminalTab before the worktree catalog names a host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the close to the host its PTY id names', () => {
    isWebRuntimeSessionActiveMock.mockImplementation((id: string | null) => id === 'env-1')
    const closeTab = vi.fn()
    getStateMock.mockReturnValue(unhydratedState(toRemoteRuntimePtyId('h-1', 'env-1'), closeTab))
    const onCancel = vi.fn()

    closeTerminalTab('tab-1', { onCancel })

    expect(onCancel).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      environmentId: 'env-1',
      reason: 'user'
    })
  })

  it('still closes the tab locally when nothing names its host', () => {
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    const closeTab = vi.fn()
    getStateMock.mockReturnValue(unhydratedState(null, closeTab))
    const onClosed = vi.fn()

    closeTerminalTab('tab-1', { onClosed })

    expect(closeTab).toHaveBeenCalledWith('tab-1')
    expect(onClosed).toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })
})
