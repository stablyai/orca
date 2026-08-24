import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTerminalWaitBlockedChanged,
  clearTerminalWaitBlockedForTests,
  getTerminalWaitBlockedReason,
  subscribeTerminalWaitBlocked
} from './terminal-wait-blocked-store'

beforeEach(() => {
  clearTerminalWaitBlockedForTests()
})

describe('terminal-wait-blocked-store', () => {
  it('records a blocked reason per pane and clears it on null', () => {
    applyTerminalWaitBlockedChanged({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      reason: 'codex-update-prompt'
    })
    expect(
      getTerminalWaitBlockedReason('tab-1', '11111111-1111-4111-8111-111111111111')
    ).toBe('codex-update-prompt')
    expect(getTerminalWaitBlockedReason('tab-2', '11111111-1111-4111-8111-111111111111')).toBeNull()

    applyTerminalWaitBlockedChanged({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      reason: null
    })
    expect(
      getTerminalWaitBlockedReason('tab-1', '11111111-1111-4111-8111-111111111111')
    ).toBeNull()
  })

  it('notifies subscribers only on an actual change', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalWaitBlocked(listener)

    applyTerminalWaitBlockedChanged({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      reason: 'agent-approval-prompt'
    })
    expect(listener).toHaveBeenCalledTimes(1)

    // Same reason again: no duplicate wake.
    applyTerminalWaitBlockedChanged({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      reason: 'agent-approval-prompt'
    })
    expect(listener).toHaveBeenCalledTimes(1)

    // A null for an unknown pane is a no-op.
    applyTerminalWaitBlockedChanged({
      tabId: 'tab-9',
      leafId: '22222222-2222-4222-8222-222222222222',
      reason: null
    })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    applyTerminalWaitBlockedChanged({
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      reason: null
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('treats missing tab or leaf as never blocked', () => {
    expect(getTerminalWaitBlockedReason(undefined, 'x')).toBeNull()
    expect(getTerminalWaitBlockedReason('tab-1', undefined)).toBeNull()
  })
})
