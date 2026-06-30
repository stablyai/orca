/**
 * @vitest-environment happy-dom
 *
 * Tests for the useTerminalErrorActions and useTerminalErrorTable hooks.
 * NOTE: This file is intentionally NOT a TerminalPane component test —
 * TerminalPane integration tests live elsewhere (or do not exist yet;
 * pty-connection.ts is exercised via pty-connection.test.ts).
 */
import { afterEach, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useAppStore } from '@/store'
import { useTerminalErrorActions } from './use-terminal-error-table'

const TEST_WORKTREE_ID = 'wt-test'

describe('useTerminalErrorActions', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      terminalErrorsByWorktreeId: {
        ...state.terminalErrorsByWorktreeId,
        [TEST_WORKTREE_ID]: []
      }
    }))
  })

  afterEach(() => {
    useAppStore.setState((state) => {
      const next = { ...state.terminalErrorsByWorktreeId }
      delete next[TEST_WORKTREE_ID]
      return { ...state, terminalErrorsByWorktreeId: next }
    })
  })

  it('appends a new entry on first sight', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => t }))
    act(() => result.current.push('SSH connection lost'))
    expect(useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]).toEqual([
      { message: 'SSH connection lost', count: 1, lastSeenAt: 1000 }
    ])
  })

  it('dedups identical entries within the window', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => t }))
    act(() => result.current.push('SSH connection lost'))
    t = 5_000
    act(() => result.current.push('SSH connection lost'))
    const entries = useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]
    expect(entries).toHaveLength(1)
    expect(entries[0].count).toBe(2)
    expect(entries[0].lastSeenAt).toBe(5_000)
  })

  it('evicts expired entries before dedup', () => {
    let t = 1_000
    const { result } = renderHook(() => useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => t }))
    act(() => result.current.push('SSH connection lost'))
    t = 40_000
    act(() => result.current.push('SSH connection lost'))
    const entries = useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]
    expect(entries).toHaveLength(1)
    expect(entries[0].count).toBe(1)
  })

  it('caps the table at 5 entries', () => {
    let t = 0
    const { result } = renderHook(() =>
      useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => (t += 100) })
    )
    act(() => {
      for (let i = 0; i < 7; i++) {
        result.current.push(`msg-${i}`)
      }
    })
    const entries = useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]
    expect(entries).toHaveLength(5)
    expect(entries[0].message).toBe('msg-2')
    expect(entries.at(-1)?.message).toBe('msg-6')
  })

  it('clear() empties the table', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => t }))
    act(() => {
      result.current.push('msg-a')
      result.current.push('msg-b')
    })
    act(() => result.current.clear())
    expect(useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]).toEqual([])
  })

  it('does not grow past 5 entries under sustained identical errors', () => {
    let t = 1000
    const { result } = renderHook(() => useTerminalErrorActions(TEST_WORKTREE_ID, { now: () => t }))
    act(() => {
      for (let i = 0; i < 100; i++) {
        result.current.push('Remote Orca runtime connection lost')
      }
      t = 5_000 // inside window
      for (let i = 0; i < 100; i++) {
        result.current.push('Remote Orca runtime connection lost')
      }
    })
    const entries = useAppStore.getState().terminalErrorsByWorktreeId[TEST_WORKTREE_ID]
    expect(entries).toHaveLength(1)
    expect(entries[0].count).toBe(200)
  })
})
