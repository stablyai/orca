import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  closeFile: vi.fn(),
  closeLocalTerminalTabState: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  closeStructuredTerminalSessionWithRetry: vi.fn(),
  disposeStructuredTerminalSession: vi.fn(),
  getState: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  reconcileTabOrder: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('@/lib/terminal-worktree-route', () => ({
  hasUnroutableTerminalWorktreeOwner: () => false,
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: null })
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: mocks.closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('../tab-bar/reconcile-order', () => ({
  reconcileTabOrder: mocks.reconcileTabOrder
}))

vi.mock('./close-local-terminal-tab-state', () => ({
  closeLocalTerminalTabState: mocks.closeLocalTerminalTabState
}))

vi.mock('./structured-terminal-session-disposal', () => ({
  closeStructuredTerminalSessionWithRetry: mocks.closeStructuredTerminalSessionWithRetry,
  disposeStructuredTerminalSession: mocks.disposeStructuredTerminalSession,
  structuredTerminalSessionId: (
    tabs: { entityId: string; structuredSessionId?: string }[],
    id: string
  ) => tabs.find((tab) => tab.entityId === id)?.structuredSessionId ?? null
}))

import { closeOtherTerminalTabs, closeTerminalTabsToRight } from './terminal-tab-bulk-actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
  mocks.reconcileTabOrder.mockReturnValue(['keep', 'close-a', 'close-b'])
  mocks.closeStructuredTerminalSessionWithRetry.mockResolvedValue(true)
})

describe('adopted native-chat disposal in legacy terminal bulk actions', () => {
  it('proves adopted-owner close before retiring other local terminals', async () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'keep' }, { id: 'close-a' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'close-a',
            contentType: 'terminal',
            viewMode: 'chat',
            structuredSessionId: 'codex-adopted-1'
          }
        ]
      },
      setActiveTab: vi.fn(),
      closeTab: mocks.closeTab
    }
    mocks.getState.mockReturnValue(state)

    await closeOtherTerminalTabs('keep', 'wt-1')

    expect(mocks.closeTab).toHaveBeenCalledWith('close-a')
    expect(mocks.closeStructuredTerminalSessionWithRetry).toHaveBeenCalledWith(
      { kind: 'local' },
      'codex-adopted-1'
    )
    expect(mocks.disposeStructuredTerminalSession).not.toHaveBeenCalled()
  })

  it('proves adopted-owner close before retiring local terminals to the right', async () => {
    const state = {
      settings: { activeRuntimeEnvironmentId: null },
      tabsByWorktree: { 'wt-1': [{ id: 'keep' }, { id: 'close-a' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'close-a',
            contentType: 'terminal',
            viewMode: 'chat',
            structuredSessionId: 'codex-adopted-2'
          }
        ]
      },
      openFiles: [],
      tabBarOrderByWorktree: { 'wt-1': ['keep', 'close-a'] },
      closeTab: mocks.closeTab,
      closeFile: mocks.closeFile
    }
    mocks.reconcileTabOrder.mockReturnValue(['keep', 'close-a'])
    mocks.getState.mockReturnValue(state)

    await closeTerminalTabsToRight('keep', 'wt-1')

    expect(mocks.closeTab).toHaveBeenCalledWith('close-a')
    expect(mocks.closeStructuredTerminalSessionWithRetry).toHaveBeenCalledWith(
      { kind: 'local' },
      'codex-adopted-2'
    )
    expect(mocks.disposeStructuredTerminalSession).not.toHaveBeenCalled()
  })

  it('keeps a structured terminal visible when provider close is unproven', async () => {
    mocks.closeStructuredTerminalSessionWithRetry.mockResolvedValue(false)
    mocks.getState.mockReturnValue({
      tabsByWorktree: { 'wt-1': [{ id: 'keep' }, { id: 'close-a' }] },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            entityId: 'close-a',
            contentType: 'terminal',
            viewMode: 'chat',
            structuredSessionId: 'codex-live-1'
          }
        ]
      },
      setActiveTab: vi.fn(),
      closeTab: mocks.closeTab
    })

    await closeOtherTerminalTabs('keep', 'wt-1')

    expect(mocks.closeTab).not.toHaveBeenCalledWith('close-a')
  })
})
