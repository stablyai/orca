import { describe, expect, it } from 'vitest'
import { combineTerminalWorktreeParkIds } from './use-manual-terminal-worktree-parking'

describe('combineTerminalWorktreeParkIds', () => {
  it('adds manually parked worktrees without dropping automatic parks', () => {
    expect(combineTerminalWorktreeParkIds(new Set(['automatic']), new Set(['manual']))).toEqual(
      new Set(['automatic', 'manual'])
    )
  })

  it('keeps the automatic set reference when there are no manual parks', () => {
    const automatic = new Set(['automatic'])

    expect(combineTerminalWorktreeParkIds(automatic, new Set())).toBe(automatic)
  })
})
