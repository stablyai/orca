import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getForegroundTerminalWorktreeIds,
  getForegroundTerminalWorktreeLastSeenAtById,
  registerVisibleTerminalWorktree,
  resetForegroundTerminalWorktreeIdsForTests,
  setForegroundTerminalWorktreeIds
} from './foreground-terminal-worktrees'

afterEach(() => {
  resetForegroundTerminalWorktreeIdsForTests()
  vi.useRealTimers()
})

describe('foreground terminal worktrees', () => {
  it('returns the union of explicit foreground ids and visible terminal claims', () => {
    setForegroundTerminalWorktreeIds(['wt-explicit', null, '', undefined])
    const unregister = registerVisibleTerminalWorktree('wt-visible')

    expect(getForegroundTerminalWorktreeIds().sort()).toEqual(['wt-explicit', 'wt-visible'])

    unregister()
    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-explicit'])
  })

  it('keeps duplicate visible worktree claims until every token unregisters', () => {
    const unregisterFirst = registerVisibleTerminalWorktree('wt-visible')
    const unregisterSecond = registerVisibleTerminalWorktree('wt-visible')

    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-visible'])

    unregisterFirst()
    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-visible'])

    unregisterSecond()
    expect(getForegroundTerminalWorktreeIds()).toEqual([])
  })

  it('records last-seen timestamps for explicit foreground entries and clears them in tests', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    setForegroundTerminalWorktreeIds(['wt-explicit', null, '', undefined])

    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-explicit': 1_000 })

    resetForegroundTerminalWorktreeIdsForTests()
    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({})
  })

  it('refreshes last-seen when explicit foreground ids leave the combined foreground set', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalWorktreeIds(['wt-old'])

    vi.setSystemTime(2_000)
    setForegroundTerminalWorktreeIds(['wt-new'])

    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({
      'wt-old': 2_000,
      'wt-new': 2_000
    })
  })

  it('does not refresh an explicit foreground removal while a visible claim remains', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalWorktreeIds(['wt-combined'])

    vi.setSystemTime(2_000)
    const unregister = registerVisibleTerminalWorktree('wt-combined')

    vi.setSystemTime(3_000)
    setForegroundTerminalWorktreeIds([])

    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-combined'])
    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-combined': 2_000 })

    vi.setSystemTime(4_000)
    unregister()

    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-combined': 4_000 })
  })

  it('refreshes visible-claim last-seen only when the last claim leaves', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregisterFirst = registerVisibleTerminalWorktree('wt-visible')

    vi.setSystemTime(2_000)
    const unregisterSecond = registerVisibleTerminalWorktree('wt-visible')

    vi.setSystemTime(3_000)
    unregisterFirst()

    expect(getForegroundTerminalWorktreeIds()).toEqual(['wt-visible'])
    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-visible': 2_000 })

    vi.setSystemTime(4_000)
    unregisterSecond()

    expect(getForegroundTerminalWorktreeIds()).toEqual([])
    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-visible': 4_000 })
  })

  it('keeps visible-claim cleanup idempotent for last-seen timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregister = registerVisibleTerminalWorktree('wt-visible')

    vi.setSystemTime(2_000)
    unregister()

    vi.setSystemTime(3_000)
    unregister()

    expect(getForegroundTerminalWorktreeLastSeenAtById()).toEqual({ 'wt-visible': 2_000 })
  })
})
