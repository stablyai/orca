import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById,
  registerVisibleTerminalTab,
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from './foreground-terminal-tabs'

afterEach(() => {
  resetForegroundTerminalTabIdsForTests()
  vi.useRealTimers()
})

describe('foreground terminal tabs', () => {
  it('returns the union of explicit foreground ids and visible terminal claims', () => {
    setForegroundTerminalTabIds(['tab-explicit', null, '', undefined])
    const unregister = registerVisibleTerminalTab('tab-visible')

    expect(getForegroundTerminalTabIds().sort()).toEqual(['tab-explicit', 'tab-visible'])

    unregister()
    expect(getForegroundTerminalTabIds()).toEqual(['tab-explicit'])
  })

  it('keeps duplicate visible terminal tab claims until every token unregisters', () => {
    const unregisterFirst = registerVisibleTerminalTab('tab-visible')
    const unregisterSecond = registerVisibleTerminalTab('tab-visible')

    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])

    unregisterFirst()
    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])

    unregisterSecond()
    expect(getForegroundTerminalTabIds()).toEqual([])
  })

  it('records last-seen timestamps for explicit foreground entries and clears them in tests', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    setForegroundTerminalTabIds(['tab-explicit', null, '', undefined])

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-explicit': 1_000 })

    resetForegroundTerminalTabIdsForTests()
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({})
  })

  it('refreshes last-seen when explicit foreground ids leave the combined foreground set', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalTabIds(['tab-old'])

    vi.setSystemTime(2_000)
    setForegroundTerminalTabIds(['tab-new'])

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({
      'tab-old': 2_000,
      'tab-new': 2_000
    })
  })

  it('does not refresh an explicit foreground removal while a visible claim remains', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    setForegroundTerminalTabIds(['tab-combined'])

    vi.setSystemTime(2_000)
    const unregister = registerVisibleTerminalTab('tab-combined')

    vi.setSystemTime(3_000)
    setForegroundTerminalTabIds([])

    expect(getForegroundTerminalTabIds()).toEqual(['tab-combined'])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-combined': 2_000 })

    vi.setSystemTime(4_000)
    unregister()

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-combined': 4_000 })
  })

  it('refreshes visible-claim last-seen only when the last claim leaves', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregisterFirst = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(2_000)
    const unregisterSecond = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(3_000)
    unregisterFirst()

    expect(getForegroundTerminalTabIds()).toEqual(['tab-visible'])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 2_000 })

    vi.setSystemTime(4_000)
    unregisterSecond()

    expect(getForegroundTerminalTabIds()).toEqual([])
    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 4_000 })
  })

  it('keeps visible-claim cleanup idempotent for last-seen timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const unregister = registerVisibleTerminalTab('tab-visible')

    vi.setSystemTime(2_000)
    unregister()

    vi.setSystemTime(3_000)
    unregister()

    expect(getForegroundTerminalTabLastSeenAtById()).toEqual({ 'tab-visible': 2_000 })
  })
})
