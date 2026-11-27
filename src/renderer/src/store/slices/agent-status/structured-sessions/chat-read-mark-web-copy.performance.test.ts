import { afterEach, expect, it, vi } from 'vitest'
import { UI_STORAGE_KEY } from '@/web/preload-api/web-storage'
import { structuredAgentSessionPaneLeaf } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { RuntimeMobileSessionAgentTab } from '../../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { createUIStore, makePersistedUI } from '../../ui/ui-slice-test-harness'
import * as legacyIndex from './chat-read-mark-legacy-index'
import {
  forgetWebChatReadMarkCensus,
  isWebChatReadMarkCopyPending,
  readWebChatMark,
  receiveWebChatReadMarkCensus,
  receiveWebChatReadMarkFrame
} from './chat-read-mark-web-copy'

const LEAF = '2b8ea975-8113-41ae-a25c-feb50cbe084a'
const LEGACY_KEY = `agent-chat-tab-v1-abc:${LEAF}`
const CONVERSATION_KEY = `structured-agent-session-sess-2:${LEAF}`

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
  const buildIndex = vi.spyOn(legacyIndex, 'indexLegacyKeys')
  const ui = { manuallyUnreadTurnsByPaneKey: { [LEGACY_KEY]: 70 } }
  let storedUI = JSON.stringify(ui)
  const setItem = vi.fn((_key: string, value: string) => {
    storedUI = value
  })
  vi.stubGlobal('window', {
    __ORCA_WEB_CLIENT__: true,
    api: { ui: { set: vi.fn().mockResolvedValue(undefined) } },
    localStorage: { getItem: (key: string) => (key === UI_STORAGE_KEY ? storedUI : null), setItem }
  })
  const store = createUIStore()
  store.setState({ unifiedTabsByWorktree: {} })
  store.getState().hydratePersistedUI(makePersistedUI(ui), 'startup')
  const indexed = buildIndex.mock.results[0]
  if (indexed?.type !== 'return') {
    throw new Error('Expected a legacy read-mark index')
  }
  const hasLeaf = vi.spyOn(indexed.value, 'has')
  const getAliases = vi.spyOn(indexed.value, 'get')
  const leafLookups = () => hasLeaf.mock.calls.length + getAliases.mock.calls.length

  const trackingRecord = { current: 'epoch', retired: [] }
  const frame = {
    environmentId: 'paired',
    runtimeId: 'runtime',
    worktreeId: 'w1',
    trackingRecord,
    affirmsChats: true
  }
  const receive = (tabs: readonly RuntimeMobileSessionAgentTab[]) =>
    receiveWebChatReadMarkFrame(store.getState(), { ...frame, tabs })
  const census = (uncovered = false) => {
    const copied = receiveWebChatReadMarkCensus(
      store.getState(),
      'paired',
      'runtime',
      uncovered ? [['w1', trackingRecord], ['w2', undefined]] : [['w1', trackingRecord]]
    )
    if (copied) {
      store.setState(copied)
    }
  }
  return { receive, census, leafLookups, setItem, store }
}

function expectStopped({ receive, leafLookups, store }: ReturnType<typeof startPendingCopy>): void {
  const lookupsBefore = leafLookups()
  receive([chatTab('sess-2')])
  expect(leafLookups()).toBe(lookupsBefore)
  const state = store.getState()
  const workspaces = vi.fn(() => [][Symbol.iterator]())
  expect(
    receiveWebChatReadMarkCensus(state, 'paired', 'runtime', { [Symbol.iterator]: workspaces })
  ).toBeUndefined()
  expect(workspaces).not.toHaveBeenCalled()
  expect(isWebChatReadMarkCopyPending()).toBe(false)
  expect(state.chatReadMarksCopiedHere).toBe(false)
  expect(readWebChatMark(state, 'manuallyUnreadTurnsByPaneKey', CONVERSATION_KEY)).toBe(70)
}

it.each([100, 1000])('looks up each of %i chat rows once and inserts nothing', (count) => {
  const { receive, leafLookups } = startPendingCopy()
  const tabs = Array.from({ length: count }, (_, id) => ({
    ...chatTab(`copy-perf-chat-${Math.floor(id / 2)}`),
    id: `copy-perf-tab-${id}`
  }))
  for (const tab of tabs) {
    structuredAgentSessionPaneLeaf(tab.sessionId)
  }
  for (const frame of [tabs, tabs, [...tabs]]) {
    const lookupsBefore = leafLookups()
    const add = vi.spyOn(Set.prototype, 'add')
    const set = vi.spyOn(Map.prototype, 'set')
    receive(frame)
    const inserts = add.mock.calls.length + set.mock.calls.length
    add.mockRestore()
    set.mockRestore()
    expect(leafLookups() - lookupsBefore).toBe(count)
    expect(inserts).toBe(0)
  }
})

it('does zero frame lookups at the original deadline after reconnect', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10_000)
  const copy = startPendingCopy()
  copy.census(true)
  clock.mockReturnValue(129_999)
  forgetWebChatReadMarkCensus('paired')
  copy.receive([chatTab('pending-before-deadline')])
  expect(copy.leafLookups()).toBe(1)

  clock.mockReturnValue(130_000)
  expectStopped(copy)
  expect(copy.setItem).not.toHaveBeenCalled()
})

it('does zero frame lookups after a failed completion write', () => {
  const copy = startPendingCopy()
  copy.setItem.mockImplementationOnce(() => {
    throw new Error('Storage quota reached')
  })
  copy.receive([chatTab('pending-before-write')])
  copy.census()

  expectStopped(copy)
  expect(copy.setItem).toHaveBeenCalledTimes(1)
})

it('does zero frame lookups after the third incomplete census', () => {
  const copy = startPendingCopy()
  copy.census(true)
  copy.census(true)
  copy.receive([chatTab('pending-after-two-censuses')])
  expect(copy.leafLookups()).toBe(1)
  copy.census(true)

  expectStopped(copy)
  expect(copy.setItem).not.toHaveBeenCalled()
})
