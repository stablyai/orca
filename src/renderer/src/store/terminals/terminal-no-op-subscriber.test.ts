import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  flushTerminalInputActivity,
  resetTerminalInputActivityCoalescingForTests
} from '@/lib/terminal-input-activity-coalescing'
import { createTestStore, makeLayout } from '../slices/store-test-helpers'

afterEach(resetTerminalInputActivityCoalescingForTests)

describe('terminal no-op subscriber budget', () => {
  it('does not publish missing-entry cleanup and restart actions', () => {
    const store = createTestStore()
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    for (let i = 0; i < 25; i += 1) {
      const s = store.getState()
      s.replaceTerminalLayoutPanePtyId('missing', 'leaf', 'pty')
      expect(s.consumeSuppressedPtyExit('missing')).toBe(false)
      expect(s.consumePendingCodexPaneRestart('missing')).toBe(false)
      s.clearCodexRestartNotice('missing')
      s.dismissCodexRestartNotices(['missing'])
      s.reopenCodexRestartPrompt('missing')
      s.markNativeChatLaunchPromptFailed('missing')
      s.clearNativeChatLaunchPrompt('missing')
      s.markNativeChatLaunchDraftAdopted('missing')
      s.resolveNativeChatLaunchDraft('missing', { text: 'draft', createdAt: 1 })
      s.clearNativeChatLaunchDraft('missing')
      s.removeDeferredSshSessionId('missing')
    }

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState()).toBe(before)
  })

  it('publishes real mutations once and keeps repeated actions silent', () => {
    const store = createTestStore()
    const draft = { tabId: 'tab', agent: 'codex', text: 'draft', createdAt: 1 } as const
    store.getState().seedNativeChatLaunchPrompt(draft)
    store.getState().seedNativeChatLaunchDraft(draft)
    store.getState().setTabLayout('tab', makeLayout())
    const listener = vi.fn()
    store.subscribe(listener)

    const actions = [
      () => store.getState().markDefaultTerminalTabsApplied('folder-workspace'),
      () => store.getState().markUnverifiedPtyLoss('tab'),
      () => store.getState().markPtySourceDisowned('pty'),
      () => store.getState().markNativeChatLaunchPromptFailed('tab'),
      () => store.getState().markNativeChatLaunchDraftAdopted('tab'),
      () => store.getState().resolveNativeChatLaunchDraft('tab', draft),
      () => store.getState().replaceTerminalLayoutPanePtyId('tab', 'leaf', 'pty'),
      () => store.getState().clearNativeChatLaunchPrompt('tab'),
      () => store.getState().clearNativeChatLaunchDraft('tab')
    ]

    for (const action of actions) {
      listener.mockClear()
      action()
      expect(listener).toHaveBeenCalledTimes(1)
      const before = store.getState()
      action()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(store.getState()).toBe(before)
    }
  })

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

  it('consumes real restart entries and leaves repeated consumes silent', () => {
    const store = createTestStore()
    store.getState().suppressPtyExit('pty')
    store.getState().queueCodexPaneRestarts(['pty'])
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.getState().consumeSuppressedPtyExit('pty')).toBe(true)
    expect(store.getState().consumePendingCodexPaneRestart('pty')).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    const before = store.getState()
    expect(store.getState().consumeSuppressedPtyExit('pty')).toBe(false)
    expect(store.getState().consumePendingCodexPaneRestart('pty')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.getState()).toBe(before)
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

  it('dismisses, reopens and clears restart notices without replaying no-op notifications', () => {
    const store = createTestStore()
    store
      .getState()
      .markCodexRestartNotices([
        { ptyId: 'pty', previousAccountLabel: 'old', nextAccountLabel: 'new' }
      ])
    const listener = vi.fn()
    store.subscribe(listener)

    const actions = [
      () => store.getState().dismissCodexRestartNotices(['pty']),
      () => store.getState().reopenCodexRestartPrompt('pty'),
      () => store.getState().clearCodexRestartNotice('pty')
    ]

    for (const [index, action] of actions.entries()) {
      if (index === 1) {
        store.getState().queueCodexPaneRestarts(['pty'])
      }

      listener.mockClear()
      action()
      expect(listener).toHaveBeenCalledTimes(1)
      const before = store.getState()
      action()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(store.getState()).toBe(before)
    }

    expect(store.getState().codexRestartNoticeByPtyId.pty).toBeUndefined()
    expect(store.getState().pendingCodexPaneRestartIds.pty).toBeUndefined()
  })
})
