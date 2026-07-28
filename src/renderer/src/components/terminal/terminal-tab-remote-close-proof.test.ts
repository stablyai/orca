import { beforeEach, expect, it, vi } from 'vitest'
import {
  TERMINAL_TAB_CLOSE_ACK_MARGIN_MS,
  TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS,
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
} from '../../../../shared/terminal-tab-close'

const { closeRemoteMock, getStateMock } = vi.hoisted(() => ({
  closeRemoteMock: vi.fn(),
  getStateMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: closeRemoteMock,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: () => true,
  isWebTerminalSurfaceTabId: () => false,
  toHostSessionTabId: (tabId: string) => tabId
}))
vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: () => 'epoch-1',
  resolveHostSessionTabIdForWebSessionTab: () => 'host-tab-1'
}))

import { closeTerminalTab } from './terminal-tab-actions'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

it('awaits paired-runtime close proof before acknowledging provider teardown', async () => {
  let resolveRemoteClose!: (closed: boolean) => void
  closeRemoteMock.mockReturnValue(
    new Promise<boolean>((resolve) => {
      resolveRemoteClose = resolve
    })
  )
  const closeTab = vi.fn(
    (
      _tabId: string,
      options: {
        registerProviderTeardown?: (teardown: Promise<void>, retry: () => Promise<void>) => void
      }
    ) => options.registerProviderTeardown?.(Promise.resolve(), () => Promise.resolve())
  )
  getStateMock.mockReturnValue({
    settings: { activeRuntimeEnvironmentId: 'web-runtime' },
    tabsByWorktree: { 'wt-1': [{ id: 'local-tab-1' }, { id: 'local-tab-2' }] },
    activeWorktreeId: 'wt-1',
    activeTabId: 'local-tab-1',
    closeTab,
    setActiveTab: vi.fn()
  })
  const onClosed = vi.fn()

  closeTerminalTab('local-tab-1', {
    onClosed,
    providerTeardownTimeoutMs: TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
  })

  const providerTeardown = onClosed.mock.calls[0]?.[0] as Promise<void>
  const rejection = expect(providerTeardown).rejects.toThrow('terminal_tab_close_failed')
  resolveRemoteClose(false)
  await rejection
  expect(closeRemoteMock).toHaveBeenCalledWith({
    worktreeId: 'wt-1',
    tabId: 'host-tab-1',
    environmentId: 'web-runtime',
    reason: 'user',
    timeoutMs: TERMINAL_TAB_CLOSE_CALLER_TIMEOUT_MS
  })
})

it('recomputes the paired-runtime timeout when a failed close is retried', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  closeRemoteMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const closeTab = vi.fn(
    (
      _tabId: string,
      options: {
        registerProviderTeardown?: (teardown: Promise<void>, retry: () => Promise<void>) => void
      }
    ) => options.registerProviderTeardown?.(Promise.resolve(), () => Promise.resolve())
  )
  const presentState = {
    settings: { activeRuntimeEnvironmentId: 'web-runtime' },
    tabsByWorktree: { 'wt-1': [{ id: 'deadline-tab' }] },
    activeWorktreeId: 'wt-1',
    activeTabId: 'deadline-tab',
    closeTab,
    setActiveTab: vi.fn()
  }
  getStateMock.mockReturnValue(presentState)
  const firstClosed = vi.fn()
  const deadlineMs = 50_000

  closeTerminalTab('deadline-tab', {
    onClosed: firstClosed,
    providerTeardownTimeoutMs: TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS,
    providerTeardownDeadlineMs: deadlineMs
  })
  await expect(firstClosed.mock.calls[0]?.[0] as Promise<void>).rejects.toThrow(
    'terminal_tab_close_failed'
  )

  vi.setSystemTime(20_000)
  getStateMock.mockReturnValue({ ...presentState, tabsByWorktree: { 'wt-1': [] } })
  const retryClosed = vi.fn()
  closeTerminalTab('deadline-tab', {
    onClosed: retryClosed,
    providerTeardownTimeoutMs: TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS,
    providerTeardownDeadlineMs: deadlineMs
  })
  await expect(retryClosed.mock.calls[0]?.[0] as Promise<void>).resolves.toBeUndefined()

  expect(closeRemoteMock.mock.calls.map(([args]) => args.timeoutMs)).toEqual([
    deadlineMs - TERMINAL_TAB_CLOSE_ACK_MARGIN_MS,
    deadlineMs - 20_000 - TERMINAL_TAB_CLOSE_ACK_MARGIN_MS
  ])
  vi.useRealTimers()
})
