import { afterEach, describe, expect, it } from 'vitest'
import {
  clearNativeChatExitSuppressForTests,
  getNativeChatExitSuppressRemainingMs,
  NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS,
  recordNativeChatOptimisticSendForExitGuard,
  resolveDeferredConfirmedAgentExitAction,
  shouldSuppressNativeChatExitForPane
} from './native-chat-exit-suppress'

afterEach(() => {
  clearNativeChatExitSuppressForTests()
})

describe('shouldSuppressNativeChatExitForPane', () => {
  it('suppresses when pending entries exist for the pane', () => {
    const cache = new Map([['tab:leaf\0codex', [{ sentAt: 10 }]]])
    expect(shouldSuppressNativeChatExitForPane('tab:leaf', cache, 11)).toBe(true)
  })

  it('suppresses within grace after recording a send even if pending is empty', () => {
    recordNativeChatOptimisticSendForExitGuard('tab:leaf', 1_000)
    const empty = new Map<string, { sentAt: number }[]>()
    expect(
      shouldSuppressNativeChatExitForPane(
        'tab:leaf',
        empty,
        1_000 + NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS - 1
      )
    ).toBe(true)
    expect(
      shouldSuppressNativeChatExitForPane(
        'tab:leaf',
        empty,
        1_000 + NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS
      )
    ).toBe(false)
  })

  it('does not suppress other panes', () => {
    recordNativeChatOptimisticSendForExitGuard('tab:leaf-a', 50)
    const cache = new Map([['tab:leaf-a\0codex', [{ sentAt: 50 }]]])
    expect(shouldSuppressNativeChatExitForPane('tab:leaf-b', cache, 60)).toBe(false)
  })

  it('reports remaining grace ms for post-suppress re-evaluation', () => {
    recordNativeChatOptimisticSendForExitGuard('tab:leaf', 1_000)
    expect(getNativeChatExitSuppressRemainingMs('tab:leaf', 1_000 + 1_000)).toBe(
      NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS - 1_000
    )
    expect(
      getNativeChatExitSuppressRemainingMs(
        'tab:leaf',
        1_000 + NATIVE_CHAT_EXIT_SUPPRESS_AFTER_SEND_MS
      )
    ).toBe(0)
  })
})

describe('resolveDeferredConfirmedAgentExitAction', () => {
  const base = {
    scheduledGeneration: 1,
    currentGeneration: 1,
    leafId: 'leaf-a',
    chatLeafId: 'leaf-a',
    stillSuppressed: false,
    titleShowsLiveAgent: false
  }

  it('applies when grace ended and the agent title is still gone', () => {
    expect(resolveDeferredConfirmedAgentExitAction(base)).toBe('apply')
  })

  it('skips a stale generation (invalidated exit)', () => {
    expect(
      resolveDeferredConfirmedAgentExitAction({
        ...base,
        currentGeneration: 2
      })
    ).toBe('skip')
  })

  it('skips when title recovered to a live agent before grace expiry', () => {
    expect(
      resolveDeferredConfirmedAgentExitAction({
        ...base,
        titleShowsLiveAgent: true
      })
    ).toBe('skip')
  })

  it('reschedules when suppress is still active', () => {
    expect(
      resolveDeferredConfirmedAgentExitAction({
        ...base,
        stillSuppressed: true
      })
    ).toBe('reschedule')
  })

  it('skips when chat ownership moved to another leaf', () => {
    expect(
      resolveDeferredConfirmedAgentExitAction({
        ...base,
        chatLeafId: 'other-leaf'
      })
    ).toBe('skip')
  })
})
