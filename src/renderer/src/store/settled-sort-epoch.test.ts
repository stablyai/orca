import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from './index'
import { SORT_SETTLE_MS } from './settled-sort-epoch'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'
import { makeWorktree } from '@/components/worktree-jump-palette-test-fixtures'

const initialState = useAppStore.getInitialState()

function bump(): void {
  useAppStore.setState((s) => ({ sortEpoch: s.sortEpoch + 1 }))
}

function settled(): boolean {
  const { sortEpoch, settledSortEpoch } = useAppStore.getState()
  return settledSortEpoch === sortEpoch
}

describe('settledSortEpoch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    vi.useRealTimers()
  })

  it('settles a bump only after the settle window, with no component mounted', () => {
    useAppStore.setState({ sortBy: 'smart' })
    bump()
    expect(settled()).toBe(false)
    vi.advanceTimersByTime(SORT_SETTLE_MS - 1)
    expect(settled()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(settled()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles Manual bumps in the same write', () => {
    useAppStore.setState({ sortBy: 'manual' })
    bump()
    expect(settled()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles a web session sync patch that bumps sortEpoch', () => {
    useAppStore.setState({ sortBy: 'recent' })
    applyWebSessionTabsStorePatch(
      (s) => ({ agentStatusEpoch: s.agentStatusEpoch + 1, sortEpoch: s.sortEpoch + 1 }),
      { frames: [] }
    )
    expect(settled()).toBe(false)
    vi.advanceTimersByTime(SORT_SETTLE_MS)
    expect(settled()).toBe(true)
  })

  it('treats an add that skipped its bump as structural on the next bump', () => {
    useAppStore.setState({ sortBy: 'recent' })
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a', 'A')] } })
    expect(vi.getTimerCount()).toBe(0)
    bump()
    expect(settled()).toBe(true)
  })

  it('settles a pending bump when a row arrives without its own bump', () => {
    useAppStore.setState({ sortBy: 'recent' })
    bump()
    expect(settled()).toBe(false)
    useAppStore.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a', 'A')] } })
    expect(settled()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores archived rows when detecting adds and removes', () => {
    useAppStore.setState((s) => ({
      sortBy: 'recent',
      worktreesByRepo: { 'repo-1': [makeWorktree('a', 'A')] },
      sortEpoch: s.sortEpoch + 1
    }))
    expect(settled()).toBe(true)
    useAppStore.setState((s) => ({
      worktreesByRepo: {
        'repo-1': [makeWorktree('a', 'A'), makeWorktree('b', 'B', { isArchived: true })]
      },
      sortEpoch: s.sortEpoch + 1
    }))
    expect(settled()).toBe(false)
  })

  it('clears a pending settle when the store is reset', () => {
    useAppStore.setState({ sortBy: 'recent' })
    bump()
    expect(vi.getTimerCount()).toBe(1)
    useAppStore.setState(initialState, true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
