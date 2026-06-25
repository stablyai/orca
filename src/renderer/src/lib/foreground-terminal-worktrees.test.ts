import { afterEach, describe, expect, it } from 'vitest'
import {
  getForegroundTerminalWorktreeIds,
  registerVisibleTerminalWorktree,
  resetForegroundTerminalWorktreeIdsForTests,
  setForegroundTerminalWorktreeIds
} from './foreground-terminal-worktrees'

afterEach(() => {
  resetForegroundTerminalWorktreeIdsForTests()
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
})
