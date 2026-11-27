import { afterEach, expect, it, vi } from 'vitest'
import { UI_STORAGE_KEY } from '@/web/preload-api/web-storage'
import type { RuntimeMobileSessionAgentTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { createSessionTabsTabDeltaDecoder } from '../../../../../../shared/remote-runtime/session-graph/session-tabs-tab-delta'
import { createUIStore, makePersistedUI } from '../../ui/ui-slice-test-harness'
import { receiveWebChatReadMarkCensus, receiveWebChatReadMarkFrame } from './chat-read-mark-web-copy'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// PR #45250: fresh paired tab arrays rebuilt all candidate membership while a copy was pending.
it.each([100, 1000])('does not reinsert %i known chats on a fresh decoded frame', (count) => {
  vi.useFakeTimers()
  const legacyKey = 'agent-chat-tab-v1-abc:2b8ea975-8113-41ae-a25c-feb50cbe084a'
  const ui = { manuallyUnreadTurnsByPaneKey: { [legacyKey]: 70 } }
  const storedUI = JSON.stringify(ui)
  const setItem = vi.fn(() => {
    throw new Error('Storage quota reached')
  })
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: true,
    localStorage: { getItem: (key: string) => (key === UI_STORAGE_KEY ? storedUI : null), setItem }
  })
  const store = createUIStore()
  store.setState({ unifiedTabsByWorktree: {} })
  store.getState().hydratePersistedUI(makePersistedUI(ui), 'startup')

  const tabs = Array.from({ length: count }, (_, index): RuntimeMobileSessionAgentTab => ({
    type: 'agent-session',
    id: `tab-${index}`,
    sessionId: `copy-perf-chat-${index}`,
    title: 'Chat',
    agent: 'codex',
    isActive: false
  }))
  const trackingRecord = { current: 'epoch', retired: [] }
  const frame = {
    environmentId: 'paired',
    runtimeId: 'runtime',
    worktreeId: 'w1',
    trackingRecord,
    affirmsChats: true
  }
  const decoder = createSessionTabsTabDeltaDecoder()
  decoder.decode({ type: 'snapshot', worktree: 'w1', tabsRevision: 1, tabs })
  receiveWebChatReadMarkFrame(store.getState(), { ...frame, tabs })
  expect(setItem).not.toHaveBeenCalled()

  const refs = tabs.map((_, index) => index)
  for (const baseRevision of [1, 2]) {
    const decoded = decoder.decode({
      type: 'updated',
      worktree: 'w1',
      tabsRevision: baseRevision + 1,
      tabsDelta: { baseRevision, tabs: refs }
    })
    if (!decoded.ok || !decoded.result || typeof decoded.result !== 'object') {
      throw new Error('Expected a decoded tab frame')
    }
    if (!('tabs' in decoded.result) || !Array.isArray(decoded.result.tabs)) {
      throw new Error('Expected decoded tabs')
    }
    expect(decoded.result.tabs).not.toBe(tabs)

    const add = vi.spyOn(Set.prototype, 'add')
    receiveWebChatReadMarkFrame(store.getState(), { ...frame, tabs: decoded.result.tabs })
    const inserts = add.mock.calls.length
    add.mockRestore()
    expect(inserts).toBe(0)

    receiveWebChatReadMarkCensus(store.getState(), 'paired', 'runtime', [['w1', trackingRecord]])
    expect(setItem).toHaveBeenCalledTimes(baseRevision)
  }
})
