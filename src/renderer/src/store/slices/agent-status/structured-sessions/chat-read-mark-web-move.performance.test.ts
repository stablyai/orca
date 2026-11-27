import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { paneKeyLeaf } from '../../../../../../shared/agent-session/view/chat-read-mark-move'
import { chatPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { useAppStore } from '@/store/index'
import { makeSnapshot } from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import { recordReceivedWebSessionTabsSnapshots } from '@/runtime/web-session-tabs-sync/tracking/session-tabs-receipts'
import { makePersistedUI } from '../../ui/ui-slice-test-harness'
import { browserChatMarks, CHAT, OLD, TAB } from './chat-read-mark-web-test-fixture'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.spyOn(performance, 'now').mockReturnValue(10_000)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('skips storage on a miss and stops walking receipts once the index empties', () => {
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } })
  const { receive } = marks.open()
  marks.localStorage.getItem.mockClear()
  marks.localStorage.setItem.mockClear()

  receive([{ ...TAB, sessionId: 'session-3' }])
  expect(marks.localStorage.getItem).not.toHaveBeenCalled()
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()

  receive([TAB])
  expect(marks.localStorage.getItem).toHaveBeenCalledTimes(1)
  const tabs = [TAB]
  Object.defineProperty(tabs, 0, {
    get: () => {
      throw new Error('Unexpected chat row lookup')
    }
  })
  receive(tabs)
  expect(marks.localStorage.getItem).toHaveBeenCalledTimes(1)
})

it('stops walking receipts at the monotonic page deadline even with pending aliases', () => {
  const marks = browserChatMarks({ manuallyUnreadTurnsByPaneKey: { [OLD]: 200 } })
  const { receive } = marks.open()
  vi.mocked(performance.now).mockReturnValue(120_000)
  const tabs = [TAB]
  Object.defineProperty(tabs, 0, {
    get: () => {
      throw new Error('Unexpected chat row lookup')
    }
  })
  marks.localStorage.getItem.mockClear()
  marks.localStorage.setItem.mockClear()

  receive(tabs)
  expect(marks.localStorage.getItem).not.toHaveBeenCalled()
  expect(marks.localStorage.setItem).not.toHaveBeenCalled()
})

it.each([
  [100, 120_000, 0, 0],
  [1000, 120_000, 0, 0],
  [100, 119_999, 100, 1],
  [1000, 119_999, 1000, 1]
])('bounds migration of a %i-row snapshot received at %i ms', (rows, time, visits, writes) => {
  const otherChat = chatPaneKey('session-3')
  const otherAlias = `agent-chat-tab-v1-other:${paneKeyLeaf(otherChat)}`
  const initial = { activityClearedAtByPaneKey: { [OLD]: 100, [otherAlias]: 200 } }
  const marks = browserChatMarks(initial)
  useAppStore.getState().hydratePersistedUI(makePersistedUI(initial), 'startup')
  marks.localStorage.getItem.mockClear()
  const first = makeSnapshot([TAB])
  const other = { ...TAB, id: 'agent-chat-tab-v1-other', sessionId: 'session-3' }
  const tabs = Array.from({ length: rows }, (_, index) =>
    index === 0 ? other : { ...TAB, id: `chat-${index}`, sessionId: `unmatched-${index}` }
  )
  const second = makeSnapshot(tabs, { worktree: 'repo::/deadline-other' })
  let rowVisits = 0
  tabs.forEach((tab, index) => {
    Object.defineProperty(tabs, index, {
      get: () => {
        rowVisits++
        return tab
      }
    })
  })
  vi.mocked(performance.now).mockReturnValue(119_999)

  recordReceivedWebSessionTabsSnapshots(`deadline-${rows}-${time}`, [first, second], {
    source: 'bootstrap',
    onReceipt: (snapshot) => {
      if (snapshot === first) {
        vi.mocked(performance.now).mockReturnValue(time)
      }
    }
  })

  expect(rowVisits).toBe(visits)
  expect(marks.localStorage.getItem).toHaveBeenCalledTimes(writes)
  expect(marks.localStorage.setItem).toHaveBeenCalledTimes(writes)
  expect(marks.stored().activityClearedAtByPaneKey).toEqual(
    writes === 1 ? { [CHAT]: 100, [otherChat]: 200 } : initial.activityClearedAtByPaneKey
  )
})

it('moves an entire bootstrap inventory before capping and publishes the marks once', () => {
  const unrelated: Record<string, number> = {}
  for (let index = 1; index <= 498; index++) {
    unrelated[`terminal-${index}:pane`] = index
  }
  const otherChat = chatPaneKey('session-3')
  const otherAlias = `agent-chat-tab-v1-other:${paneKeyLeaf(otherChat)}`
  const secondAlias = `agent-chat-tab-v1-reopened:${paneKeyLeaf(CHAT)}`
  const initial = {
    activityClearedAtByPaneKey: { ...unrelated, [OLD]: 600, [secondAlias]: 550, [otherAlias]: 700 }
  }
  const marks = browserChatMarks(initial)
  useAppStore.getState().hydratePersistedUI(makePersistedUI(initial), 'startup')
  const publish = vi.fn()
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.activityClearedAtByPaneKey !== previous.activityClearedAtByPaneKey) {
      publish()
    }
  })

  try {
    recordReceivedWebSessionTabsSnapshots(
      'bootstrap-env',
      [
        makeSnapshot([{ ...TAB, id: 'agent-chat-tab-v1-other', sessionId: 'session-3' }], {
          worktree: 'repo::/other'
        }),
        makeSnapshot([TAB])
      ],
      { source: 'bootstrap' }
    )

    const expected = { ...unrelated, [CHAT]: 600, [otherChat]: 700 }
    expect(marks.localStorage.getItem).toHaveBeenCalledTimes(1)
    expect(marks.localStorage.setItem).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(marks.stored().activityClearedAtByPaneKey).toEqual(expected)
    expect(useAppStore.getState().activityClearedAtByPaneKey).toEqual(expected)
  } finally {
    unsubscribe()
  }
})
