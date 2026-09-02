/**
 * `recordTerminalInput` used to run one `set()` per keystroke, waking every zustand
 * subscriber in the store. It is now coalesced: leading-edge write, then one trailing
 * flush per window. These tests pin the properties that make that safe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: { pty: { kill: vi.fn().mockResolvedValue(undefined) } } }

import {
  TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS,
  flushTerminalInputActivity,
  mergePendingTerminalInputActivity,
  readLastTerminalInputAt,
  resetTerminalInputActivityCoalescingForTests
} from '@/lib/terminal-input-activity-coalescing'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:leaf-a'

describe('recordTerminalInput store writes are coalesced', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalInputActivityCoalescingForTests()
  })

  it('does not write the store on every keystroke', () => {
    const store = createTestStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    for (let i = 0; i < 50; i++) {
      store.getState().recordTerminalInput(PANE, 1_000 + i * 15)
    }
    unsubscribe()

    // 50 keystrokes inside ~750ms: leading edge plus at most one window boundary.
    expect(listener.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('keeps the freshest stamp visible to imperative readers before the flush', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput(PANE, 1_000)
    store.getState().recordTerminalInput(PANE, 1_200)

    const stored = store.getState().lastTerminalInputAtByPaneKey
    expect(stored[PANE]).toBe(1_000)
    expect(readLastTerminalInputAt(stored, PANE)).toBe(1_200)
    expect(mergePendingTerminalInputActivity(stored)[PANE]).toBe(1_200)

    vi.advanceTimersByTime(TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS + 1)
    expect(store.getState().lastTerminalInputAtByPaneKey[PANE]).toBe(1_200)
  })

  it('writes the very first stamp for a pane synchronously', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput(PANE, 1_000)

    expect(store.getState().lastTerminalInputAtByPaneKey[PANE]).toBe(1_000)
  })

  it('does not resurrect a pane key a purge deleted', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput(PANE, 1_000)
    store.getState().recordTerminalInput(PANE, 1_200)

    // Teardown path (worktree purge / pane close) rewrites the map without the key.
    store.setState({ lastTerminalInputAtByPaneKey: {} })
    flushTerminalInputActivity()

    const stored = store.getState().lastTerminalInputAtByPaneKey
    expect(stored[PANE]).toBeUndefined()
    expect(readLastTerminalInputAt(stored, PANE)).toBeUndefined()
    expect(mergePendingTerminalInputActivity(stored)[PANE]).toBeUndefined()
  })

  it('ignores invalid pane keys and timestamps', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput('', 1_000)
    store.getState().recordTerminalInput(PANE, Number.NaN)

    expect(store.getState().lastTerminalInputAtByPaneKey).toEqual({})
  })
})
