// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { makeTab, makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { createNotificationsApi } from '../web/preload-api/web-notifications-api'

const leaf = '11111111-1111-4111-8111-111111111111'
const group = 'away-group'
const pane = makePaneKey('away-tab', leaf)
const readAway = vi.fn<() => Promise<boolean | undefined>>()
const dismiss = vi.fn()
const previousApi = window.api
beforeEach(() => {
  readAway.mockReset().mockResolvedValue(true)
  dismiss.mockReset()
  vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
  Object.assign(window, { api: { notifications: { getDesktopAwayState: readAway, dismiss } } })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useAppStore.setState({
    activeView: 'terminal',
    activeTabId: 'away-tab',
    activeWorktreeId: 'away-workspace',
    activeTabIdByWorktree: { 'away-workspace': 'away-tab' },
    activeGroupIdByWorktree: { 'away-workspace': group },
    tabsByWorktree: {
      'away-workspace': [
        makeTab({ id: 'away-tab', worktreeId: 'away-workspace' }),
        makeTab({ id: 'other-tab', worktreeId: 'away-workspace' })
      ]
    },
    unifiedTabsByWorktree: {
      'away-workspace': [
        makeUnifiedTab({ id: 'away-tab', worktreeId: 'away-workspace', groupId: group }),
        makeUnifiedTab({ id: 'other-tab', worktreeId: 'away-workspace', groupId: group })
      ]
    },
    groupsByWorktree: {
      'away-workspace': [
        makeTabGroup({
          id: group,
          worktreeId: 'away-workspace',
          activeTabId: 'away-tab',
          tabOrder: ['away-tab', 'other-tab']
        })
      ]
    },
    terminalLayoutsByTabId: {
      'away-tab': { root: { type: 'leaf', leafId: leaf }, activeLeafId: leaf, expandedLeafId: null }
    },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    manuallyUnreadTurnsByPaneKey: {}
  })
  useAppStore
    .getState()
    .setAgentStatus(pane, { state: 'done', prompt: 'away test', agentType: 'codex' })
  useAppStore.getState().markAgentCompletionPaneUnread(pane, 'agent-completion')
})
afterEach(() => {
  cleanup()
  Object.assign(window, { api: previousApi })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('leaves the focused pane unread while desktop is away, then acknowledges on user return', async () => {
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {
    await Promise.resolve()
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
  readAway.mockResolvedValue(false)
  const input = new Event('pointerdown')
  Object.defineProperty(input, 'isTrusted', { value: true })
  act(() => window.dispatchEvent(input))
  await waitFor(() =>
    expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
  )
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('does not acknowledge when the presence query fails or the hook unmounts', async () => {
  let resolve!: (away: boolean) => void
  readAway.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const hook = renderHook(() => useAutoAckViewedAgent())
  hook.unmount()
  await act(async () => {
    resolve(false)
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  readAway.mockRejectedValue(new Error('unavailable'))
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {
    await Promise.resolve()
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
})

it('acknowledges focused web completions despite unsupported native presence', async () => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  readAway.mockImplementation(createNotificationsApi().getDesktopAwayState)
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
  expect(dismiss).toHaveBeenCalledTimes(1)
  expect(readAway).not.toHaveBeenCalled()
})

it('keeps native unknown presence conservative', async () => {
  readAway.mockResolvedValue(undefined)
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  act(() => window.dispatchEvent(new Event('focus')))
  await act(async () => {})
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
})

it.each(['focus', 'visibilitychange'])('rescans pending web attention on %s', async (signal) => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  readAway.mockImplementation(createNotificationsApi().getDesktopAwayState)
  const focus = vi.mocked(document.hasFocus).mockReturnValue(false)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
  focus.mockReturnValue(true)
  visibility.mockReturnValue('visible')
  act(() => (signal === 'focus' ? window : document).dispatchEvent(new Event(signal)))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('ignores unrelated writes while away but queries for a new completion', async () => {
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  expect(readAway).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      useAppStore.setState({ settings: useAppStore.getState().settings })
    })
  }
  expect(readAway).toHaveBeenCalledTimes(1)
  await act(async () => {
    useAppStore.setState({ unreadAgentCompletionPanes: { [pane]: true } })
  })
  expect(readAway).toHaveBeenCalledTimes(2)
  // An unclassified legacy boolean marker still drives the away query and the ack.
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe(true)
  readAway.mockResolvedValue(false)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('does not query presence for a visible pane without attention', async () => {
  useAppStore.setState({ agentStatusByPaneKey: {}, unreadAgentCompletionPanes: {} })
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(readAway).not.toHaveBeenCalled()
})

it('rechecks focus after a pending presence query resolves', async () => {
  let resolve!: (away: boolean) => void
  readAway.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  renderHook(() => useAutoAckViewedAgent())
  vi.mocked(document.hasFocus).mockReturnValue(false)
  await act(async () => resolve(false))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
  vi.mocked(document.hasFocus).mockReturnValue(true)
  readAway.mockResolvedValue(false)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
})

it('rechecks the selected pane after a coalesced presence query resolves', async () => {
  let resolve!: (away: boolean) => void
  readAway.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  renderHook(() => useAutoAckViewedAgent())
  act(() => useAppStore.getState().activateTab('other-tab'))
  expect(readAway).toHaveBeenCalledTimes(1)
  await act(async () => resolve(false))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  expect(dismiss).not.toHaveBeenCalled()
  readAway.mockResolvedValue(false)
  await act(async () => useAppStore.getState().activateTab('away-tab'))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
})

it.each([false, true])('preserves manual unread across return signals (web=%s)', async (web) => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', web)
  readAway.mockResolvedValue(false)
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  act(() => useAppStore.getState().unacknowledgeAgents([pane]))
  const turn = useAppStore.getState().agentStatusByPaneKey[pane]!.stateStartedAt
  dismiss.mockClear()
  await act(async () => window.dispatchEvent(new Event('focus')))
  const input = new Event('pointerdown')
  Object.defineProperty(input, 'isTrusted', { value: true })
  act(() => window.dispatchEvent(input))
  expect(useAppStore.getState().acknowledgedAgentsByPaneKey[pane]).toBeUndefined()
  expect(useAppStore.getState().manuallyUnreadTurnsByPaneKey[pane]).toBe(turn)
  expect(dismiss).not.toHaveBeenCalled()
})

it('keeps a selected grid card bell unread while away and clears only that card on return', async () => {
  useAppStore.setState({
    activeView: 'sessions',
    activeWorktreeId: 'another-workspace',
    activeSessionGridTabId: 'away-tab',
    sessionsGridFilter: 'all',
    sessionsGridHiddenTabIds: [],
    agentStatusByPaneKey: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: { 'away-tab': true, 'other-tab': true }
  })
  const clearWorkspace = vi.spyOn(useAppStore.getState(), 'clearWorktreeUnread')
  renderHook(() => useAutoAckViewedAgent())
  await act(async () => {})
  expect(readAway).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().unreadTerminalTabs['away-tab']).toBe(true)
  readAway.mockResolvedValue(false)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(useAppStore.getState().unreadTerminalTabs['away-tab']).toBeUndefined()
  expect(useAppStore.getState().unreadTerminalTabs['other-tab']).toBe(true)
  // The other card still owns unread attention in this workspace.
  expect(clearWorkspace).not.toHaveBeenCalledWith('away-workspace')
  expect(clearWorkspace).not.toHaveBeenCalledWith('another-workspace')
})

it('rechecks the selected grid card when a pending presence query resolves', async () => {
  useAppStore.setState({
    activeView: 'sessions',
    activeSessionGridTabId: 'away-tab',
    sessionsGridFilter: 'all',
    sessionsGridHiddenTabIds: []
  })
  let resolve!: (away: boolean) => void
  readAway.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  renderHook(() => useAutoAckViewedAgent())
  act(() => useAppStore.setState({ activeSessionGridTabId: null }))
  await act(async () => resolve(false))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe('agent-completion')
  readAway.mockResolvedValue(false)
  await act(async () => useAppStore.setState({ activeSessionGridTabId: 'away-tab' }))
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
})
