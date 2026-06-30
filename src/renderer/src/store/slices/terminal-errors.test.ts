import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createTerminalErrorsSlice } from './terminal-errors'
import type { AppState } from '../types'

function makeStore() {
  // Why: zustand slice creators return a partial of the full state, so we cast
  // through `unknown` to coerce the slice's TerminalErrorsSlice into AppState.
  // Matches the pattern used by every other store-level test in this repo.
  return create<AppState>()((...a) => createTerminalErrorsSlice(...a) as unknown as AppState)
}

describe('createTerminalErrorsSlice', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushTerminalError appends a new entry', () => {
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'msg', 1000)
    expect(store.getState().terminalErrorsByWorktreeId.wt).toEqual([
      { message: 'msg', count: 1, lastSeenAt: 1000 }
    ])
  })

  it('uses Date.now() when no timestamp is supplied', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-30T00:00:00Z'))
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'msg')
    expect(store.getState().terminalErrorsByWorktreeId.wt[0].lastSeenAt).toBe(Date.now())
  })

  it('dedups identical messages within the window and increments count', () => {
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'msg', 1000)
    store.getState().pushTerminalError('wt', 'msg', 5000)
    expect(store.getState().terminalErrorsByWorktreeId.wt).toEqual([
      { message: 'msg', count: 2, lastSeenAt: 5000 }
    ])
  })

  it('evicts entries outside the dedup window before counting toward cap', () => {
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'stale', 0)
    store.getState().pushTerminalError('wt', 'fresh', 30_001)
    expect(store.getState().terminalErrorsByWorktreeId.wt).toEqual([
      { message: 'fresh', count: 1, lastSeenAt: 30_001 }
    ])
  })

  it('caps the table at 5 entries (drops the oldest when full and new arrives)', () => {
    const store = makeStore()
    for (let i = 0; i < 7; i++) {
      store.getState().pushTerminalError('wt', `m-${i}`, i * 1000)
    }
    expect(store.getState().terminalErrorsByWorktreeId.wt).toHaveLength(5)
    expect(store.getState().terminalErrorsByWorktreeId.wt[0].message).toBe('m-2')
    expect(store.getState().terminalErrorsByWorktreeId.wt.at(-1)?.message).toBe('m-6')
  })

  it('rejects a negative `now` timestamp (defensive)', () => {
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'msg', -1)
    expect(store.getState().terminalErrorsByWorktreeId.wt).toBeUndefined()
  })

  it('rejects a non-finite `now` (NaN/Infinity)', () => {
    const store = makeStore()
    store.getState().pushTerminalError('wt', 'msg', Number.NaN)
    store.getState().pushTerminalError('wt', 'msg2', Number.POSITIVE_INFINITY)
    expect(store.getState().terminalErrorsByWorktreeId.wt).toBeUndefined()
  })

  it('rejects an empty-string worktreeId', () => {
    const store = makeStore()
    store.getState().pushTerminalError('', 'msg', 1000)
    store.getState().clearTerminalErrors('')
    expect(store.getState().terminalErrorsByWorktreeId).toEqual({})
  })

  it('clearTerminalErrors preserves unrelated worktree entries', () => {
    const store = makeStore()
    store.getState().pushTerminalError('a', 'a-msg', 1000)
    store.getState().pushTerminalError('b', 'b-msg', 1000)
    store.getState().clearTerminalErrors('a')
    expect(store.getState().terminalErrorsByWorktreeId.a).toEqual([])
    expect(store.getState().terminalErrorsByWorktreeId.b).toHaveLength(1)
  })

  it('clearTerminalErrors on an absent key is a no-op (no state churn)', () => {
    const store = makeStore()
    store.getState().pushTerminalError('a', 'a-msg', 1000)
    const before = store.getState()
    store.getState().clearTerminalErrors('never-pushed')
    // Early-return guarantees the slice map reference is unchanged
    expect(store.getState().terminalErrorsByWorktreeId).toBe(before.terminalErrorsByWorktreeId)
  })
})
