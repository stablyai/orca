// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const schedulerMock = vi.hoisted(() => ({
  schedules: [] as {
    callback: () => void
    cancelled: boolean
    options: { delayMs: number; quietMs: number; idleTimeoutMs: number }
  }[]
}))

vi.mock('@/lib/input-quiet-scheduler', () => ({
  scheduleAfterInputQuiet: vi.fn(
    (
      callback: () => void,
      options: { delayMs: number; quietMs: number; idleTimeoutMs: number }
    ) => {
      const schedule = { callback, cancelled: false, options }
      schedulerMock.schedules.push(schedule)
      return () => {
        schedule.cancelled = true
      }
    }
  )
}))

import {
  TERMINAL_WORKTREE_RENDER_DELAY_MS,
  TERMINAL_WORKTREE_RENDER_IDLE_TIMEOUT_MS,
  TERMINAL_WORKTREE_RENDER_INPUT_QUIET_MS,
  useDeferredTerminalWorktreeRender
} from './use-deferred-terminal-worktree-render'

describe('useDeferredTerminalWorktreeRender', () => {
  beforeEach(() => {
    schedulerMock.schedules = []
  })

  it('keeps rendering the prior terminal shell until input is quiet', () => {
    const { result, rerender } = renderHook(
      ({ activeWorktreeId }) => useDeferredTerminalWorktreeRender(activeWorktreeId),
      { initialProps: { activeWorktreeId: 'wt-a' as string | null } }
    )

    rerender({ activeWorktreeId: 'wt-b' })

    expect(result.current).toBe('wt-a')
    expect(schedulerMock.schedules).toHaveLength(1)
    expect(schedulerMock.schedules[0]?.options).toEqual({
      delayMs: TERMINAL_WORKTREE_RENDER_DELAY_MS,
      quietMs: TERMINAL_WORKTREE_RENDER_INPUT_QUIET_MS,
      idleTimeoutMs: TERMINAL_WORKTREE_RENDER_IDLE_TIMEOUT_MS
    })

    act(() => schedulerMock.schedules[0]?.callback())

    expect(result.current).toBe('wt-b')
  })

  it('cancels an intermediate terminal shell render when the user clicks back', () => {
    const { result, rerender } = renderHook(
      ({ activeWorktreeId }) => useDeferredTerminalWorktreeRender(activeWorktreeId),
      { initialProps: { activeWorktreeId: 'wt-a' as string | null } }
    )

    rerender({ activeWorktreeId: 'wt-b' })
    const intermediateSchedule = schedulerMock.schedules[0]
    rerender({ activeWorktreeId: 'wt-a' })

    expect(intermediateSchedule?.cancelled).toBe(true)
    expect(result.current).toBe('wt-a')
    expect(schedulerMock.schedules).toHaveLength(1)
  })

  it('switches immediately when there is no prior rendered terminal shell', () => {
    const { result, rerender } = renderHook(
      ({ activeWorktreeId }) => useDeferredTerminalWorktreeRender(activeWorktreeId),
      { initialProps: { activeWorktreeId: null as string | null } }
    )

    rerender({ activeWorktreeId: 'wt-a' })

    expect(result.current).toBe('wt-a')
    expect(schedulerMock.schedules).toHaveLength(0)
  })
})
