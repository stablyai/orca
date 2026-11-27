import { afterEach, expect, it, vi } from 'vitest'
import { UI_STORAGE_KEY } from '@/web/preload-api/web-storage'
import type { RuntimeMobileSessionAgentTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { createSessionTabsTabDeltaDecoder } from '../../../../../../shared/remote-runtime/session-graph/session-tabs-tab-delta'
import { createUIStore, makePersistedUI } from '../../ui/ui-slice-test-harness'
import * as legacyIndex from './chat-read-mark-legacy-index'
import {
  isWebChatReadMarkCopyPending,
  receiveWebChatReadMarkCensus,
  receiveWebChatReadMarkFrame
} from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const LEGACY_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function chatTab(sessionId: string): RuntimeMobileSessionAgentTab {
  return {
    type: 'agent-session',
    id: `tab-${sessionId}`,
    sessionId,
    title: 'Chat',
    agent: 'codex',
    isActive: false
  }
}

function startPendingCopy() {
  vi.useFakeTimers()
  const ui = { manuallyUnreadTurnsByPaneKey: { [LEGACY_KEY]: 70 } }
  let storedUI = JSON.stringify(ui)
  let storageAvailable = false
  const setItem = vi.fn((_key: string, value: string) => {
    if (!storageAvailable) {
      throw new Error('Storage quota reached')
    }
    storedUI = value
  })
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: true,
    localStorage: { getItem: (key: string) => (key === UI_STORAGE_KEY ? storedUI : null), setItem }
  })
  const store = createUIStore()
  store.setState({ unifiedTabsByWorktree: {} })
  store.getState().hydratePersistedUI(makePersistedUI(ui), 'startup')

  const trackingRecord = { current: 'epoch', retired: [] }
  const frame = {
    environmentId: 'paired',
    runtimeId: 'runtime',
    worktreeId: 'w1',
    trackingRecord,
    affirmsChats: true
  }
  const receive = (
    tabs: readonly RuntimeMobileSessionAgentTab[],
    scanChatSessions?: Parameters<typeof receiveWebChatReadMarkFrame>[1]['scanChatSessions']
  ) => receiveWebChatReadMarkFrame(store.getState(), { ...frame, tabs, scanChatSessions })
  const census = () => {
    const copied = receiveWebChatReadMarkCensus(store.getState(), 'paired', 'runtime', [
      ['w1', trackingRecord]
    ])
    if (copied) {
      store.setState(copied)
    }
  }
  return {
    receive,
    census,
    setItem,
    store,
    recoverStorage: () => {
      storageAvailable = true
    }
  }
}

function expectNoMembershipInserts(receive: () => void): void {
  const add = vi.spyOn(Set.prototype, 'add')
  const set = vi.spyOn(Map.prototype, 'set')
  receive()
  const inserts = add.mock.calls.length + set.mock.calls.length
  add.mockRestore()
  set.mockRestore()
  expect(inserts).toBe(0)
}

// PR #45250: decoded frames repeated candidate work while a read-mark copy was pending.
it.each([100, 1000])('skips candidate work for %i chats with unchanged membership', (count) => {
  const index = vi.spyOn(legacyIndex, 'indexLegacyKeys')
  const { receive, census, setItem } = startPendingCopy()
  const probes = index.mock.results.flatMap((result) =>
    result.type === 'return' ? [vi.spyOn(result.value, 'has')] : []
  )
  expect(probes).toHaveLength(2)

  const tabs = Array.from({ length: count }, (_, id) => chatTab(`copy-perf-chat-${id}`))
  const decoder = createSessionTabsTabDeltaDecoder()
  decoder.decode({ type: 'snapshot', worktree: 'w1', tabsRevision: 1, tabs })
  receive(tabs)
  expect(setItem).not.toHaveBeenCalled()
  expect(probes.map((probe) => probe.mock.calls.length)).toEqual([count, count])

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

    const decodedTabs: unknown[] = decoded.result.tabs
    if (
      decodedTabs.length !== tabs.length ||
      !decodedTabs.every(
        (tab, index): tab is RuntimeMobileSessionAgentTab => tab !== undefined && tab === tabs[index]
      )
    ) {
      throw new Error('Expected the decoder to reuse every chat row')
    }
    const scan = vi.fn((visit: (sessionId: string) => void) => {
      for (const tab of decodedTabs) {
        visit(tab.sessionId)
      }
    })
    for (const probe of probes) {
      probe.mockClear()
    }
    expectNoMembershipInserts(() => receive(decodedTabs, scan))
    expect(scan).not.toHaveBeenCalled()
    for (const probe of probes) {
      expect(probe).not.toHaveBeenCalled()
    }

    census()
    expect(setItem).toHaveBeenCalledTimes(baseRevision)
  }

  for (const probe of probes) {
    probe.mockClear()
  }
  const retitled = tabs.map((tab) => ({ ...tab, title: 'Updated chat' }))
  expectNoMembershipInserts(() => receive(retitled))
  for (const probe of probes) {
    expect(probe).not.toHaveBeenCalled()
  }
})

// PR #45250: failed storage writes let a workspace retain IDs for every closed chat.
it.each([100, 1000])('bounds membership through %i opens and closes', (count) => {
  const { receive, census, setItem, store, recoverStorage } = startPendingCopy()
  const kept = chatTab('copy-perf-kept-open')
  const duplicate = { ...kept, id: 'copy-perf-duplicate-tab' }
  receive([kept])
  census()
  expect(setItem).toHaveBeenCalledTimes(1)

  const expectMembershipSize = (other: RuntimeMobileSessionAgentTab, size: number): void => {
    const get = vi.spyOn(Map.prototype, 'get')
    receive([{ ...kept }, other])
    const lookup = get.mock.calls.findIndex(([sessionId]) => sessionId === kept.sessionId)
    const membership = get.mock.contexts[lookup]
    get.mockRestore()
    expect(membership instanceof Map ? membership.size : undefined).toBe(size)
  }

  for (let id = 0; id < count; id++) {
    const opened = chatTab(`copy-perf-churn-${id}`)
    receive([kept, opened])
    expectMembershipSize(opened, 2)
    receive([kept, duplicate])
    expectMembershipSize(duplicate, 1)
  }

  receive([kept, chatTab('sess-2')])
  receive([kept])
  expect(setItem).toHaveBeenCalledTimes(1)
  recoverStorage()
  census()
  expect(setItem).toHaveBeenCalledTimes(2)
  expect(store.getState().manuallyUnreadTurnsByPaneKey).toEqual({
    [LEGACY_KEY]: 70,
    [CONVERSATION_KEY]: 70
  })
  expect(isWebChatReadMarkCopyPending()).toBe(false)
})
