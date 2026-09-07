// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceKanbanDrawerLingering } from './use-workspace-kanban-drawer-lingering'

describe('workspace board close linger', () => {
  afterEach(() => vi.useRealTimers())

  it('keeps drawer state through the close animation, then releases it at 300 ms', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useWorkspaceKanbanDrawerLingering(open),
      { initialProps: { open: true } }
    )
    act(() => rerender({ open: false }))
    act(() => vi.advanceTimersByTime(299))
    expect(result.current).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(false)
  })

  it('cancels the pending release when reopened', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useWorkspaceKanbanDrawerLingering(open),
      { initialProps: { open: true } }
    )
    act(() => rerender({ open: false }))
    act(() => vi.advanceTimersByTime(299))
    act(() => rerender({ open: true }))
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })
})
