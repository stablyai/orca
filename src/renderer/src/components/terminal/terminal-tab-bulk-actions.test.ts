import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  archiveTerminalTabBeforeRetirementMock,
  canArchiveTerminalTabCloseMock,
  closeWebRuntimeSessionTabMock,
  getLatestWebSessionTabsPublicationEpochMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  isWebTerminalSurfaceTabIdMock,
  isTerminalArchiveTopologyCurrentMock,
  resolveHostSessionTabIdForWebSessionTabMock,
  terminalArchiveCloseUnavailableErrorMock,
  toHostSessionTabIdMock
} = vi.hoisted(() => ({
  archiveTerminalTabBeforeRetirementMock: vi.fn(),
  canArchiveTerminalTabCloseMock: vi.fn(() => false),
  closeWebRuntimeSessionTabMock: vi.fn(),
  getLatestWebSessionTabsPublicationEpochMock: vi.fn(() => 'epoch-1'),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(),
  isWebTerminalSurfaceTabIdMock: vi.fn(() => false),
  isTerminalArchiveTopologyCurrentMock: vi.fn(() => true),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null),
  terminalArchiveCloseUnavailableErrorMock: vi.fn(
    () =>
      new Error('Terminal archive protection is unavailable. Keep this tab open and reload Orca.')
  ),
  toHostSessionTabIdMock: vi.fn((tabId: string) => tabId)
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

import { closeOtherTerminalTabs, closeTerminalTabsToRight } from './terminal-tab-actions'

describe('closeOtherTerminalTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates other terminal closes to the host runtime in paired web clients', async () => {
    const setActiveTab = vi.fn()
    const closeTab = vi.fn()
    let resolveFirstReceipt: (receipt: { closed: true; archiveId: string }) => void = () => {}
    let resolveSecondReceipt: (receipt: { closed: true; archiveId: string }) => void = () => {}
    const firstReceipt = new Promise<{ closed: true; archiveId: string }>((resolve) => {
      resolveFirstReceipt = resolve
    })
    const secondReceipt = new Promise<{ closed: true; archiveId: string }>((resolve) => {
      resolveSecondReceipt = resolve
    })
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    closeWebRuntimeSessionTabMock
      .mockReturnValueOnce(firstReceipt)
      .mockReturnValueOnce(secondReceipt)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'keep' }, { id: 'close-a' }, { id: 'close-b' }]
      },
      setActiveTab,
      closeTab
    })

    const closePromise = closeOtherTerminalTabs('keep', 'wt-1')

    expect(setActiveTab).toHaveBeenCalledWith('keep')
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1))
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-a',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeTab).not.toHaveBeenCalled()

    resolveFirstReceipt({ closed: true, archiveId: '11111111-1111-4111-8111-111111111111' })
    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith('close-a', {
        reason: undefined,
        remoteCloseOwnedByHost: true
      })
    )
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2))
    expect(closeWebRuntimeSessionTabMock).toHaveBeenLastCalledWith({
      worktreeId: 'wt-1',
      tabId: 'close-b',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeTab).toHaveBeenCalledTimes(1)

    resolveSecondReceipt({ closed: true, archiveId: '22222222-2222-4222-8222-222222222222' })
    await closePromise

    expect(closeTab).toHaveBeenCalledTimes(2)
    expect(closeTab).toHaveBeenNthCalledWith(2, 'close-b', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
  })
})

describe('closeTerminalTabsToRight', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
  })

  it('delegates terminal tabs to the host while still closing local editor tabs to the right', async () => {
    const closeTab = vi.fn()
    const closeFile = vi.fn()
    let resolveFirstReceipt: (receipt: { closed: true; archiveId: string }) => void = () => {}
    let resolveSecondReceipt: (receipt: { closed: true; archiveId: string }) => void = () => {}
    const firstReceipt = new Promise<{ closed: true; archiveId: string }>((resolve) => {
      resolveFirstReceipt = resolve
    })
    const secondReceipt = new Promise<{ closed: true; archiveId: string }>((resolve) => {
      resolveSecondReceipt = resolve
    })
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    closeWebRuntimeSessionTabMock
      .mockReturnValueOnce(firstReceipt)
      .mockReturnValueOnce(secondReceipt)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      tabsByWorktree: {
        'wt-1': [{ id: 'term-a' }, { id: 'term-b' }, { id: 'term-c' }]
      },
      openFiles: [{ id: 'file-b', worktreeId: 'wt-1' }],
      tabBarOrderByWorktree: { 'wt-1': ['term-a', 'file-b', 'term-b', 'term-c'] },
      closeTab,
      closeFile
    })

    const closePromise = closeTerminalTabsToRight('term-a', 'wt-1')

    expect(closeFile).toHaveBeenCalledWith('file-b')
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1))
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'term-b',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeTab).not.toHaveBeenCalled()

    resolveFirstReceipt({ closed: true, archiveId: '33333333-3333-4333-8333-333333333333' })
    await vi.waitFor(() =>
      expect(closeTab).toHaveBeenCalledWith('term-b', {
        reason: undefined,
        remoteCloseOwnedByHost: true
      })
    )
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2))
    expect(closeWebRuntimeSessionTabMock).toHaveBeenLastCalledWith({
      worktreeId: 'wt-1',
      tabId: 'term-c',
      environmentId: 'web-runtime',
      reason: 'user'
    })
    expect(closeTab).toHaveBeenCalledTimes(1)

    resolveSecondReceipt({ closed: true, archiveId: '44444444-4444-4444-8444-444444444444' })
    await closePromise

    expect(closeTab).toHaveBeenCalledTimes(2)
    expect(closeTab).toHaveBeenNthCalledWith(2, 'term-c', {
      reason: undefined,
      remoteCloseOwnedByHost: true
    })
  })
})
