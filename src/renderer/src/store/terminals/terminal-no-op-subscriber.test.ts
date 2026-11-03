import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushTerminalInputActivity,
  resetTerminalInputActivityCoalescingForTests
} from '@/lib/terminal-input-activity-coalescing'
import { createTestStore } from '../slices/store-test-helpers'

afterEach(resetTerminalInputActivityCoalescingForTests)

describe('terminal no-op subscriber budget', () => {
  it('retains draft generations when stale resolutions arrive without notifying', () => {
    const store = createTestStore()
    const draft = { tabId: 'tab', agent: 'codex', text: 'new draft', createdAt: 2 } as const
    store.getState().seedNativeChatLaunchDraft(draft)
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    store.getState().resolveNativeChatLaunchDraft('tab', { ...draft, createdAt: 1 })
    store.getState().resolveNativeChatLaunchDraft('tab', { ...draft, text: 'old draft' })

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
    expect(store.getState().nativeChatLaunchDraftByTabId.tab).toBe(draft)
  })

  it('drops a trailing input flush after pane teardown without publishing', () => {
    const store = createTestStore()
    store.getState().recordTerminalInput('tab:leaf', 1000)
    store.getState().recordTerminalInput('tab:leaf', 1001)
    store.setState({ lastTerminalInputAtByPaneKey: {} })
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    flushTerminalInputActivity()

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
    expect(store.getState().lastTerminalInputAtByPaneKey['tab:leaf']).toBeUndefined()
  })
})
