// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { takeAllPendingBackgroundTerminalWorktreeMounts } from '@/components/terminal/background-terminal-worktree-mount'
import { useSessionGridCardRestore } from './use-session-grid-card-restore'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  takeAllPendingBackgroundTerminalWorktreeMounts()
})

describe('session grid card restoration', () => {
  it('requires a load action for an exited saved pty, just like a null pty', () => {
    const { result } = renderHook(() =>
      useSessionGridCardRestore({ worktreeId: 'wt', tabId: 'saved', ptyId: 'exited' })
    )
    act(() => result.current.onPtyGone())
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([])
    expect(result.current.restoring).toBe(false)
    expect(result.current.failed).toBe(true)
    // An exited pty is "not connected"; only a run-out grace period is a timeout.
    expect(result.current.timedOut).toBe(false)
    act(() => result.current.restore())
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([
      { worktreeId: 'wt', tabIds: ['saved'] }
    ])
  })

  it('ends an unsuccessful restore and permits an explicit retry', () => {
    vi.useFakeTimers()
    const { result, unmount } = renderHook(() =>
      useSessionGridCardRestore({ worktreeId: 'wt', tabId: 'tab', ptyId: null })
    )
    act(() => {
      result.current.restore()
      result.current.restore()
    })
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toHaveLength(1)
    act(() => vi.advanceTimersByTime(15_000))
    expect(result.current.restoring).toBe(false)
    expect(result.current.failed).toBe(true)
    expect(result.current.timedOut).toBe(true)
    act(() => result.current.restore())
    expect(result.current.restoring).toBe(true)
    expect(result.current.failed).toBe(false)
    expect(result.current.timedOut).toBe(false)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads a cold card on request without mounting its siblings or navigating', () => {
    const { result, rerender } = renderHook(
      ({ ptyId }: { ptyId: string | null }) =>
        useSessionGridCardRestore({ worktreeId: 'folder', tabId: 'cold', ptyId }),
      { initialProps: { ptyId: null as string | null } }
    )
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([])
    act(() => result.current.restore())
    expect(result.current.restoring).toBe(true)
    expect(takeAllPendingBackgroundTerminalWorktreeMounts()).toEqual([
      { worktreeId: 'folder', tabIds: ['cold'] }
    ])
    rerender({ ptyId: 'fresh' })
    expect(result.current.restoring).toBe(false)
  })
})
