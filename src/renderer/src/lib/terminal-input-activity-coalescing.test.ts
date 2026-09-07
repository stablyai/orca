import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS,
  flushTerminalInputActivity,
  getPendingTerminalInputActivityCountForTests,
  mergePendingTerminalInputActivity,
  readLastTerminalInputAt,
  recordTerminalInputActivity,
  resetTerminalInputActivityCoalescingForTests
} from './terminal-input-activity-coalescing'

const PANE = 'tab-1:leaf-1'
const OTHER_PANE = 'tab-2:leaf-2'

// Minimal stand-in for the store slot the real commit writes into.
function createStore(initial: Record<string, number> = {}) {
  const stored: Record<string, number | undefined> = { ...initial }
  const writes: string[] = []
  return {
    stored,
    writes,
    commit: {
      insert: (paneKey: string, timestamp: number) => {
        writes.push(`insert:${paneKey}`)
        stored[paneKey] = timestamp
      },
      refreshExisting: (entries: readonly (readonly [string, number])[]) => {
        writes.push('flush')
        for (const [paneKey, timestamp] of entries) {
          const current = stored[paneKey]
          if (current === undefined || current >= timestamp) {
            continue
          }
          stored[paneKey] = timestamp
        }
      }
    }
  }
}

function type(store: ReturnType<typeof createStore>, paneKey: string, timestamp: number): void {
  recordTerminalInputActivity({
    paneKey,
    timestamp,
    forceWrite: store.stored[paneKey] === undefined,
    commit: store.commit
  })
}

describe('terminal input activity coalescing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalInputActivityCoalescingForTests()
  })

  it('writes the first keystroke immediately and coalesces the burst', () => {
    const store = createStore()

    // 40 keystrokes at 20ms apart = one 800ms burst.
    for (let i = 0; i < 40; i++) {
      type(store, PANE, 1_000 + i * 20)
    }

    // Leading edge + one interval boundary crossing; no per-keystroke writes.
    expect(store.writes.filter((w) => w.startsWith('insert')).length).toBeLessThanOrEqual(2)
    expect(store.writes.length).toBeLessThan(5)
    expect(store.stored[PANE]).toBeDefined()
  })

  it('keeps imperative reads fresh while a write is pending', () => {
    const store = createStore()

    type(store, PANE, 1_000)
    type(store, PANE, 1_100)

    // The store itself still holds the leading-edge stamp...
    expect(store.stored[PANE]).toBe(1_000)
    // ...but readers see the pending keystroke.
    expect(getPendingTerminalInputActivityCountForTests()).toBe(1)
    expect(readLastTerminalInputAt(store.stored, PANE)).toBe(1_100)
    expect(mergePendingTerminalInputActivity(store.stored)[PANE]).toBe(1_100)
  })

  it('returns the same map reference when nothing is pending', () => {
    const store = createStore({ [PANE]: 500 })
    expect(mergePendingTerminalInputActivity(store.stored)).toBe(store.stored)
  })

  it('flushes pending stamps into the store on the timer', () => {
    const store = createStore()

    type(store, PANE, 1_000)
    type(store, PANE, 1_100)
    vi.advanceTimersByTime(TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS + 1)

    expect(store.stored[PANE]).toBe(1_100)
    expect(getPendingTerminalInputActivityCountForTests()).toBe(0)
  })

  it('does not resurrect a pane key that teardown deleted', () => {
    const store = createStore()

    type(store, PANE, 1_000)
    type(store, OTHER_PANE, 1_000)
    type(store, PANE, 1_100)
    type(store, OTHER_PANE, 1_100)
    expect(getPendingTerminalInputActivityCountForTests()).toBe(2)

    // Teardown (close pane / close tab / worktree purge) removes the key.
    delete store.stored[PANE]

    flushTerminalInputActivity()

    expect(PANE in store.stored).toBe(false)
    expect(readLastTerminalInputAt(store.stored, PANE)).toBeUndefined()
    expect(mergePendingTerminalInputActivity(store.stored)[PANE]).toBeUndefined()
    // The surviving sibling still advances.
    expect(store.stored[OTHER_PANE]).toBe(1_100)
  })

  it('clears the flush timer so a reset leaves no pending work', () => {
    const store = createStore()

    type(store, PANE, 1_000)
    type(store, PANE, 1_100)
    resetTerminalInputActivityCoalescingForTests()
    vi.advanceTimersByTime(TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS * 4)

    expect(store.stored[PANE]).toBe(1_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('writes immediately again once the coalescing window has passed', () => {
    const store = createStore()

    type(store, PANE, 1_000)
    type(store, PANE, 1_000 + TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS)

    expect(store.writes).toEqual([`insert:${PANE}`, `insert:${PANE}`])
    expect(store.stored[PANE]).toBe(1_000 + TERMINAL_INPUT_ACTIVITY_WRITE_INTERVAL_MS)
  })
})
